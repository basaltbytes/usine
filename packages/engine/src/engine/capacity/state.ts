import { Harness, ModelId, type BrainSpec } from "@usine/core/agent/brain";
import {
  type Attempt,
  type AttemptId,
  capacityBackoff,
  capacityRefusal,
} from "@usine/core/attempt";
import type { AttemptFailure } from "@usine/core/attempt/failure";
import { jsonKey } from "@usine/core/json-key";
import type { LoopName } from "@usine/core/loop";
import { RunId } from "@usine/core/run";
import { WorkerName } from "@usine/core/worker";
import { Array as EffectArray, type Brand, DateTime, Option, Order, Schema } from "effect";

/**
 * The harness and model of an Attempt's child sessions on one Worker, which a provider capacity
 * refusal applies to. The Worker holds the harness credential, and a model can have its own usage
 * limit.
 */
export class CapacityGroup extends Schema.Class<
  CapacityGroup,
  Brand.Brand<"@usine/engine/engine/capacity/state/CapacityGroup">
>("@usine/engine/CapacityGroup")({
  /** The harness of the Attempt's child sessions. */
  harness: Harness,
  /** The model of the Attempt's child sessions. */
  model: ModelId,
  /** The Worker whose credential the harness used. */
  worker: WorkerName,
}) {}

/** Returns the capacity group of `brain` on `worker`. */
export const capacityGroupOf = (
  brain: Pick<BrainSpec, "harness" | "model">,
  worker: WorkerName,
): CapacityGroup => CapacityGroup.make({ harness: brain.harness, model: brain.model, worker });

/** Identifies `group` in the capacity state and in the operator's attention entries. */
export const capacityGroupKey = (group: CapacityGroup): string =>
  jsonKey([group.worker, group.harness, group.model]);

/** A capacity group whose provider refuses requests, and the Runs that wait for it. */
export class CapacityWait extends Schema.Class<
  CapacityWait,
  Brand.Brand<"@usine/engine/engine/capacity/state/CapacityWait">
>("@usine/engine/CapacityWait")({
  group: CapacityGroup,
  /** The provider's latest refusal. */
  message: Schema.NonEmptyString,
  /** The end of the first refusal since the provider last answered in the group. */
  since: Schema.DateTimeUtcFromString,
  /** The refusals that each lengthened the wait: one per Attempt that tested the group. */
  refusals: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  /** The earliest time that the next Attempt tests the group. */
  nextTryAt: Schema.DateTimeUtcFromString,
  /** The Runs whose Attempt tests the group now. */
  probes: Schema.Array(RunId),
  /** The Runs that wait for the group without an Attempt. */
  runIds: Schema.Array(RunId),
}) {}

/** A capacity refusal that ended an Attempt of a Run of `loop`. */
export interface CapacityRefusal {
  readonly runId: RunId;
  readonly loop: LoopName;
  readonly group: CapacityGroup;
  readonly attemptId: AttemptId;
  readonly startedAt: DateTime.Utc;
  readonly endedAt: DateTime.Utc;
  readonly message: string;
  readonly resetsAt: Option.Option<DateTime.Utc>;
}

/** Returns the capacity refusal that ended `attempt`, or `None` without one or an end time. */
export const refusalOf = (attempt: Attempt, loop: LoopName): Option.Option<CapacityRefusal> =>
  Option.flatMap(capacityRefusal(attempt), (failure) =>
    Option.map(attempt.endedAt, (endedAt) => ({
      runId: attempt.runId,
      loop,
      group: capacityGroupOf(attempt.brain, attempt.worker),
      attemptId: attempt.id,
      startedAt: attempt.startedAt,
      endedAt,
      message: failure.message,
      resetsAt: failure.resetsAt,
    })),
  );

interface GroupState {
  readonly group: CapacityGroup;
  /** Ordered by end time. */
  readonly refusals: EffectArray.NonEmptyReadonlyArray<CapacityRefusal>;
  readonly probes: ReadonlySet<RunId>;
}

interface Waiter {
  readonly key: string;
  readonly loop: LoopName;
}

/** The capacity groups at capacity in this process, and the Runs that wait for them. */
export interface CapacityState {
  readonly groups: ReadonlyMap<string, GroupState>;
  readonly waiting: ReadonlyMap<RunId, Waiter>;
  /** The time the provider last answered in each group; older refusals are stale. */
  readonly answered: ReadonlyMap<string, DateTime.Utc>;
  /** The Runs whose next claim or wait an operator retry ends. */
  readonly forced: ReadonlySet<RunId>;
}

export const emptyCapacity: CapacityState = {
  groups: new Map(),
  waiting: new Map(),
  answered: new Map(),
  forced: new Set(),
};

const byEnd = Order.mapInput(DateTime.Order, ({ endedAt }: CapacityRefusal) => endedAt);

/**
 * Returns the refusals that lengthened the wait, the end of the latest refusal, and the next try.
 * A refusal lengthens the wait only if its Attempt started after an earlier refusal ended, so
 * Attempts that were already running when the limit started count once.
 */
export const scheduleOf = (refusals: EffectArray.NonEmptyReadonlyArray<CapacityRefusal>) => {
  const [first, ...rest] = refusals;
  let steps = 1;
  let latest = first.endedAt;
  for (const refusal of rest) {
    if (DateTime.isGreaterThan(refusal.startedAt, latest)) steps += 1;
    latest = DateTime.max(latest, refusal.endedAt);
  }
  const backoff = DateTime.addDuration(latest, capacityBackoff(steps));
  const nextTryAt = refusals
    .flatMap(({ resetsAt }) => Option.toArray(resetsAt))
    .reduce(DateTime.max, backoff);
  return { steps, latest, nextTryAt };
};

const without = <K, V>(map: ReadonlyMap<K, V>, key: K): ReadonlyMap<K, V> => {
  const next = new Map(map);
  next.delete(key);
  return next;
};

const withoutRun = (runs: ReadonlySet<RunId>, runId: RunId): ReadonlySet<RunId> =>
  new Set([...runs].filter((id) => id !== runId));

/** Removes `runId` from the probes of every group but `except`, and returns the groups it left. */
const leaveProbes = (state: CapacityState, runId: RunId, except?: string) => {
  const left = [...state.groups].flatMap(([key, group]) =>
    key !== except && group.probes.has(runId) ? [key] : [],
  );
  const groups = new Map(
    [...state.groups].map(([key, group]) => [
      key,
      left.includes(key) ? { ...group, probes: withoutRun(group.probes, runId) } : group,
    ]),
  );
  return { left, groups };
};

/** Drops the groups that no Run waits for or tests, which a later refusal marks again. */
const dropIdle = (state: CapacityState): CapacityState => {
  const needed = new Set([...state.waiting.values()].map(({ key }) => key));
  return {
    ...state,
    groups: new Map(
      [...state.groups].filter(([key, group]) => needed.has(key) || group.probes.size > 0),
    ),
  };
};

/** Returns the Runs that wait for the group `key`, with their Loops. */
export const waitersOf = (state: CapacityState, key: string) =>
  [...state.waiting].flatMap(([runId, waiter]) =>
    waiter.key === key ? [[runId, waiter.loop] as const] : [],
  );

const waitOf = (state: CapacityState, key: string, group: GroupState): CapacityWait => {
  const { steps, nextTryAt } = scheduleOf(group.refusals);
  return CapacityWait.make({
    group: group.group,
    message: EffectArray.lastNonEmpty(group.refusals).message,
    since: EffectArray.headNonEmpty(group.refusals).endedAt,
    refusals: steps,
    nextTryAt,
    probes: [...group.probes],
    runIds: waitersOf(state, key).map(([runId]) => runId),
  });
};

/** Returns the wait of the group `key`, or `None` if it isn't at capacity. */
export const waitFor = (state: CapacityState, key: string): Option.Option<CapacityWait> =>
  Option.map(Option.fromUndefinedOr(state.groups.get(key)), (group) => waitOf(state, key, group));

/** Returns the groups at capacity, ordered by when they started refusing. */
export const waitsOf = (state: CapacityState): ReadonlyArray<CapacityWait> =>
  [...state.groups]
    .map(([key, group]) => waitOf(state, key, group))
    .sort((left, right) => DateTime.Order(left.since, right.since));

/**
 * How `refused` recorded a refusal: `Stale` if it ended before the provider last answered in its
 * group, `Known` if it was recorded before and its Run still waits, `Rejoined` if it was recorded
 * before and its Run waits for its group again, and `Marked` if it marked the group.
 */
export type Refused = "Stale" | "Known" | "Rejoined" | "Marked";

/** Records `refusal` and that its Run waits for the refused group, unless it is stale. */
export const refused = (
  state: CapacityState,
  refusal: CapacityRefusal,
): readonly [Refused, CapacityState] => {
  const key = capacityGroupKey(refusal.group);
  const answeredAt = state.answered.get(key);
  if (answeredAt !== undefined && !DateTime.isGreaterThan(refusal.endedAt, answeredAt))
    return ["Stale", state];
  const existing = state.groups.get(key);
  const recorded = existing?.refusals.some(({ attemptId }) => attemptId === refusal.attemptId);
  // A Run registers its refusals again each time it waits; it keeps the group it waits for.
  if (recorded === true && state.waiting.has(refusal.runId)) return ["Known", state];
  const { groups } = leaveProbes(state, refusal.runId);
  const waiting = new Map(state.waiting).set(refusal.runId, { key, loop: refusal.loop });
  if (existing !== undefined && recorded === true)
    return ["Rejoined", dropIdle({ ...state, groups, waiting })];
  const refusals: EffectArray.NonEmptyReadonlyArray<CapacityRefusal> =
    existing === undefined
      ? [refusal]
      : EffectArray.sort(EffectArray.append(existing.refusals, refusal), byEnd);
  const probes = withoutRun(existing?.probes ?? new Set(), refusal.runId);
  return [
    "Marked",
    dropIdle({
      ...state,
      waiting,
      groups: new Map(groups).set(key, { group: refusal.group, refusals, probes }),
    }),
  ];
};

/**
 * What `answered` did: nothing because the group isn't at capacity (`Free`) or the Attempt started
 * before the group's latest refusal (`Earlier`), or it released the group and its waiting Runs.
 */
export type Answered =
  | { readonly _tag: "Free" }
  | { readonly _tag: "Earlier" }
  | {
      readonly _tag: "Released";
      readonly runs: ReadonlyArray<readonly [RunId, LoopName]>;
    };

/**
 * Records that the provider answered the Attempt of `runId` that started at `startedAt` in
 * `group`. It releases the group and its waiting Runs if the Attempt tests the group or started
 * after the group's latest refusal; an Attempt that started earlier was already running when the
 * provider refused.
 */
export const answered = (
  state: CapacityState,
  answer: {
    readonly runId: RunId;
    readonly group: CapacityGroup;
    readonly startedAt: DateTime.Utc;
    readonly now: DateTime.Utc;
  },
): readonly [Answered, CapacityState] => {
  const key = capacityGroupKey(answer.group);
  const existing = state.groups.get(key);
  if (existing === undefined) return [{ _tag: "Free" }, state];
  const { latest } = scheduleOf(existing.refusals);
  if (!existing.probes.has(answer.runId) && !DateTime.isGreaterThan(answer.startedAt, latest))
    return [{ _tag: "Earlier" }, state];
  return [
    { _tag: "Released", runs: waitersOf(state, key) },
    {
      ...state,
      groups: without(state.groups, key),
      waiting: new Map([...state.waiting].filter(([, waiter]) => waiter.key !== key)),
      answered: new Map(state.answered).set(key, answer.now),
    },
  ];
};

/**
 * What a Run may do in a group: start an Attempt because the group isn't at capacity (`Free`),
 * start the Attempt that tests it (`Probe`), or wait without an Attempt (`Wait`).
 */
export type CapacityClaim = "Free" | "Probe" | "Wait";

/**
 * How a Run's wait for its capacity group ended: its turn came or it waited for no group (`Due`),
 * or an operator retry ended it (`Forced`).
 */
export type CapacityTurn = "Due" | "Forced";

/** What `claim` decided, whether an operator retry forced it, and the groups the Run left. */
export interface Claimed {
  readonly claim: CapacityClaim;
  readonly forced: boolean;
  /** The groups that the Run stopped testing because it got a slot for another group. */
  readonly left: ReadonlyArray<string>;
}

/**
 * Decides whether the Run `runId` of `loop` starts an Attempt in `group` at `now`. A Run tests a
 * group at capacity when it was elected to, when no Attempt tests the group and its next try has
 * come, or when an operator retry forced its turn. Otherwise it waits for the group.
 */
export const claim = (
  state: CapacityState,
  request: {
    readonly runId: RunId;
    readonly loop: LoopName;
    readonly group: CapacityGroup;
    readonly turn: CapacityTurn;
    readonly now: DateTime.Utc;
  },
): readonly [Claimed, CapacityState] => {
  const { runId } = request;
  const key = capacityGroupKey(request.group);
  const forced = request.turn === "Forced" || state.forced.has(runId);
  const { left, groups } = leaveProbes(state, runId, key);
  const next: CapacityState = { ...state, groups, forced: withoutRun(state.forced, runId) };
  const existing = groups.get(key);
  if (existing === undefined)
    return [
      { claim: "Free", forced, left },
      dropIdle({ ...next, waiting: without(state.waiting, runId) }),
    ];
  const due =
    existing.probes.has(runId) ||
    (existing.probes.size === 0 &&
      !DateTime.isLessThan(request.now, scheduleOf(existing.refusals).nextTryAt));
  if (!forced && !due)
    return [
      { claim: "Wait", forced, left },
      dropIdle({
        ...next,
        waiting: new Map(state.waiting).set(runId, { key, loop: request.loop }),
      }),
    ];
  return [
    { claim: "Probe", forced, left },
    dropIdle({
      ...next,
      waiting: without(state.waiting, runId),
      groups: new Map(groups).set(key, {
        ...existing,
        probes: new Set([...existing.probes, runId]),
      }),
    }),
  ];
};

/**
 * The next step of a Run's wait for its group: an operator retry ended it (`Forced`), the Run
 * waits for no group (`Free`), its Attempt tests the group (`Due`), it waits until the group's
 * next try (`Sleep`), or it waits while another Attempt tests the group (`AwaitProbe`).
 */
export type TurnStep =
  | { readonly _tag: "Forced" }
  | { readonly _tag: "Free" }
  | { readonly _tag: "Due"; readonly elected: boolean; readonly group: CapacityGroup }
  | { readonly _tag: "Sleep"; readonly until: DateTime.Utc; readonly group: CapacityGroup }
  | { readonly _tag: "AwaitProbe"; readonly group: CapacityGroup };

/**
 * Returns the next step of the wait of `runId` at `now`. When no Attempt tests its group and the
 * next try has come, it elects the Run to test the group, so only one waiting Run does.
 */
export const turn = (
  state: CapacityState,
  runId: RunId,
  now: DateTime.Utc,
): readonly [TurnStep, CapacityState] => {
  if (state.forced.has(runId))
    return [{ _tag: "Forced" }, { ...state, forced: withoutRun(state.forced, runId) }];
  const waiter = state.waiting.get(runId);
  const entry = waiter === undefined ? undefined : state.groups.get(waiter.key);
  if (waiter === undefined || entry === undefined) return [{ _tag: "Free" }, state];
  const { group } = entry;
  if (entry.probes.has(runId)) return [{ _tag: "Due", elected: false, group }, state];
  if (entry.probes.size > 0) return [{ _tag: "AwaitProbe", group }, state];
  const { nextTryAt } = scheduleOf(entry.refusals);
  if (DateTime.isLessThan(now, nextTryAt))
    return [{ _tag: "Sleep", until: nextTryAt, group }, state];
  return [
    { _tag: "Due", elected: true, group },
    {
      ...state,
      groups: new Map(state.groups).set(waiter.key, { ...entry, probes: new Set([runId]) }),
    },
  ];
};

/** How an Attempt ended, for `settled`: it succeeded, or failed with the failure's tag. */
export type AttemptEnd = "Succeeded" | AttemptFailure["_tag"];

/**
 * What `settled` did to the group of an Attempt that ended: what `answered` did, nothing for a
 * capacity refusal (`Refused`), or the groups that the Run stopped testing (`Left`).
 */
export type Settled =
  | Answered
  | { readonly _tag: "Refused" }
  | { readonly _tag: "Left"; readonly groups: ReadonlyArray<string> };

/**
 * Settles the group of the Attempt of `runId` that started at `startedAt` and ended with `end`.
 * A success, or a failure that the provider answered, counts as an answer. A capacity refusal
 * changes nothing; the Run registers it when it waits. An infrastructure failure or a defect
 * doesn't show whether the provider answered, so the Run only stops testing the group.
 */
export const settled = (
  state: CapacityState,
  ended: {
    readonly runId: RunId;
    readonly group: CapacityGroup;
    readonly startedAt: DateTime.Utc;
    readonly end: AttemptEnd;
    readonly now: DateTime.Utc;
  },
): readonly [Settled, CapacityState] => {
  switch (ended.end) {
    case "ProviderCapacityFailure":
      return [{ _tag: "Refused" }, state];
    case "InfraFailure":
    case "DefectFailure": {
      const [groups, next] = leave(state, ended.runId);
      return [{ _tag: "Left", groups }, next];
    }
    default:
      return answered(state, ended);
  }
};

/** Records that an operator retry ends the next or current wait of `runId`. */
export const force = (state: CapacityState, runId: RunId): CapacityState => ({
  ...state,
  forced: new Set([...state.forced, runId]),
});

/**
 * Removes `runId` from the waiting Runs, the testing Attempts, and the forced retries, and
 * returns the groups it waited for or tested.
 */
export const leave = (
  state: CapacityState,
  runId: RunId,
): readonly [ReadonlyArray<string>, CapacityState] => {
  const { left, groups } = leaveProbes(state, runId);
  const waited = Option.toArray(
    Option.map(Option.fromUndefinedOr(state.waiting.get(runId)), ({ key }) => key),
  );
  return [
    [...waited, ...left],
    dropIdle({
      ...state,
      groups,
      waiting: without(state.waiting, runId),
      forced: withoutRun(state.forced, runId),
    }),
  ];
};
