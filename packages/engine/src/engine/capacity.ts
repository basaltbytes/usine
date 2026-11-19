import { InstanceScope } from "@usine/core/access";
import { Harness, ModelId } from "@usine/core/agent/brain";
import { type Attempt, AttemptId, capacityBackoff } from "@usine/core/attempt";
import type { ProviderCapacityFailure } from "@usine/core/attempt/failure";
import { ChangeBus, type ScopedChange } from "@usine/core/changes";
import { jsonKey } from "@usine/core/json-key";
import type { LoopName } from "@usine/core/loop";
import { RunId } from "@usine/core/run";
import { WorkerName } from "@usine/core/worker";
import {
  Array as EffectArray,
  type Brand,
  Context,
  DateTime,
  Deferred,
  Duration,
  Effect,
  Layer,
  Option,
  Order,
  Ref,
  Schema,
} from "effect";

/**
 * The harness and model of an Attempt's child sessions and the Worker it ran on. A Worker holds
 * the credential of each harness, so a pool stands for one billing pool: a harness and its
 * credential. A model with its own usage limit has its own pool.
 */
export class CapacityPool extends Schema.Class<
  CapacityPool,
  Brand.Brand<"@usine/engine/engine/capacity/CapacityPool">
>("@usine/engine/CapacityPool")({
  /** The harness of the Attempt's child sessions. */
  harness: Harness,
  /** The model of the Attempt's child sessions. */
  model: ModelId,
  /** The Worker whose credential the harness used. */
  worker: WorkerName,
}) {}

/** Returns the pool of the child brain and Worker of `attempt`. */
const capacityPoolOf = (attempt: Pick<Attempt, "brain" | "worker">): CapacityPool =>
  CapacityPool.make({
    harness: attempt.brain.harness,
    model: attempt.brain.model,
    worker: attempt.worker,
  });

/** A pool whose provider refuses requests for capacity, and the Runs that wait for it. */
export class CapacityWait extends Schema.Class<
  CapacityWait,
  Brand.Brand<"@usine/engine/engine/capacity/CapacityWait">
>("@usine/engine/CapacityWait")({
  pool: CapacityPool,
  /** The provider's latest refusal. */
  message: Schema.NonEmptyString,
  /** The end of the first refusal since the provider last answered on the pool. */
  since: Schema.DateTimeUtcFromString,
  /** The refusals that each lengthened the wait: one per Attempt that tested the pool. */
  refusals: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  /** The earliest time that the next Attempt tests the pool. */
  nextTryAt: Schema.DateTimeUtcFromString,
  /** The Runs whose Attempt tests the pool now. */
  probes: Schema.Array(RunId),
  /** The Runs that wait for the pool without an Attempt. */
  runIds: Schema.Array(RunId),
}) {}

/** What `ProviderCapacity.claim` allows a Run to do on a pool. */
export type CapacityClaim = "Free" | "Probe" | "Wait";

/** How `ProviderCapacity.awaitTurn` ended: the Run's turn came, or the operator forced a retry. */
export type CapacityTurn = "Due" | "Forced";

interface Refusal {
  readonly attemptId: AttemptId;
  readonly startedAt: DateTime.Utc;
  readonly endedAt: DateTime.Utc;
  readonly message: string;
  readonly resetsAt: Option.Option<DateTime.Utc>;
}

interface PoolState {
  readonly pool: CapacityPool;
  /** Ordered by end time. */
  readonly refusals: EffectArray.NonEmptyReadonlyArray<Refusal>;
  readonly probes: ReadonlySet<RunId>;
}

interface Waiter {
  readonly key: string;
  readonly loop: LoopName;
}

interface State {
  readonly pools: ReadonlyMap<string, PoolState>;
  readonly waiting: ReadonlyMap<RunId, Waiter>;
  /** The time the provider last answered on each pool; older refusals are stale. */
  readonly answered: ReadonlyMap<string, DateTime.Utc>;
}

const keyOf = (pool: CapacityPool) => jsonKey([pool.worker, pool.harness, pool.model]);

/**
 * Returns the refusals that lengthened the wait, the end of the latest refusal, and the next try.
 * A refusal lengthens the wait only if its Attempt started after an earlier refusal ended, so
 * Attempts that were already running when the limit started count once.
 */
const scheduleOf = (refusals: EffectArray.NonEmptyReadonlyArray<Refusal>) => {
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

const waitOf = (state: State, key: string, pool: PoolState): CapacityWait => {
  const { steps, nextTryAt } = scheduleOf(pool.refusals);
  return CapacityWait.make({
    pool: pool.pool,
    message: EffectArray.lastNonEmpty(pool.refusals).message,
    since: EffectArray.headNonEmpty(pool.refusals).endedAt,
    refusals: steps,
    nextTryAt,
    probes: [...pool.probes],
    runIds: [...state.waiting].flatMap(([runId, waiter]) => (waiter.key === key ? [runId] : [])),
  });
};

const without = <K, V>(map: ReadonlyMap<K, V>, key: K): ReadonlyMap<K, V> => {
  const next = new Map(map);
  next.delete(key);
  return next;
};

const withoutProbe = (pools: ReadonlyMap<string, PoolState>, runId: RunId) =>
  new Map(
    [...pools].map(([key, pool]) => [
      key,
      pool.probes.has(runId)
        ? { ...pool, probes: new Set([...pool.probes].filter((id) => id !== runId)) }
        : pool,
    ]),
  );

/** Drops the pools that no Run waits for or tests, which a later refusal marks again. */
const dropIdle = (state: State): State => {
  const needed = new Set([...state.waiting.values()].map(({ key }) => key));
  return {
    ...state,
    pools: new Map(
      [...state.pools].filter(([key, pool]) => needed.has(key) || pool.probes.size > 0),
    ),
  };
};

/**
 * Tracks the billing pools whose provider refuses requests for capacity, in this process. A
 * refusal marks the pool; Runs that need it wait without an Attempt, one Attempt at a time tests
 * it after the backoff, and the first answer from its provider releases the waiting Runs. After a
 * restart, each Run that waits registers its refusals again.
 */
export class ProviderCapacity extends Context.Service<
  ProviderCapacity,
  {
    /**
     * Records that `failure` ended `attempt` of a Run of `loop`, and that the Run waits for the
     * attempt's pool. A refusal that ended before the provider last answered on the pool changes
     * nothing. Recording a refusal again changes nothing.
     */
    readonly refused: (
      attempt: Attempt,
      failure: ProviderCapacityFailure,
      loop: LoopName,
    ) => Effect.Effect<void>;
    /**
     * Records that the provider of `attempt` answered. It releases the pool and its waiting Runs
     * if the Attempt tests the pool or started after the pool's latest refusal.
     */
    readonly answered: (attempt: Attempt) => Effect.Effect<void>;
    /**
     * Decides whether the Run `runId` of `loop` starts an Attempt on `pool` now. `Free` if the
     * pool isn't at capacity, `Probe` if the Attempt tests it, and `Wait` if the Run waits for it.
     * A `forced` claim, an operator's retry, always tests the pool.
     */
    readonly claim: (
      runId: RunId,
      loop: LoopName,
      pool: CapacityPool,
      forced: boolean,
    ) => Effect.Effect<CapacityClaim>;
    /**
     * Waits until the pool that `runId` waits for is free, or has no testing Attempt and reached
     * its next try. Returns `Due` at once if the Run waits for no pool, and `Forced` if `force`
     * ends the wait.
     */
    readonly awaitTurn: (runId: RunId) => Effect.Effect<CapacityTurn>;
    /**
     * Ends the next or current wait of `runId` for an operator retry. Returns whether a waiting
     * fiber of the Run was woken.
     */
    readonly force: (runId: RunId) => Effect.Effect<boolean>;
    /** Removes `runId` from the waiting Runs and the testing Attempts. */
    readonly leave: (runId: RunId) => Effect.Effect<void>;
    /** The pools at capacity, ordered by when they started refusing. */
    readonly waits: Effect.Effect<ReadonlyArray<CapacityWait>>;
  }
>()("@usine/engine/engine/capacity/ProviderCapacity") {
  static readonly layer = Layer.effect(
    ProviderCapacity,
    Effect.gen(function* () {
      const bus = yield* ChangeBus;
      const state = yield* Ref.make<State>({
        pools: new Map(),
        waiting: new Map(),
        answered: new Map(),
      });
      const initial = yield* Deferred.make<void>();
      const changed = yield* Ref.make(initial);
      // The waiting fiber of each Run, and the Runs whose next wait an operator retry ends.
      const wakes = yield* Ref.make<ReadonlyMap<RunId, Deferred.Deferred<void>>>(new Map());
      const forced = yield* Ref.make<ReadonlySet<RunId>>(new Set());
      const unforce = (runId: RunId) =>
        Ref.update(forced, (runs) => new Set([...runs].filter((id) => id !== runId)));

      /** Wakes every waiting Run, and refreshes the attention view and the views of `runs`. */
      const announce = Effect.fn("ProviderCapacity.announce")(function* (
        runs: ReadonlyArray<readonly [RunId, LoopName]>,
      ) {
        const next = yield* Deferred.make<void>();
        const previous = yield* Ref.getAndSet(changed, next);
        yield* Deferred.succeed(previous, undefined);
        const changes: Array<ScopedChange> = [
          { audience: InstanceScope.make(), target: { kind: "attention", id: "instance" } },
          ...runs.map(([runId, loop]): ScopedChange => ({
            audience: { _tag: "Loop", loop },
            target: { kind: "run", id: runId },
          })),
        ];
        yield* bus.publish(changes);
      });

      const waitersOf = (current: State, key: string) =>
        [...current.waiting].flatMap(([runId, waiter]) =>
          waiter.key === key ? [[runId, waiter.loop] as const] : [],
        );

      const refused = Effect.fn("ProviderCapacity.refused")(function* (
        attempt: Attempt,
        failure: ProviderCapacityFailure,
        loop: LoopName,
      ) {
        const pool = capacityPoolOf(attempt);
        const key = keyOf(pool);
        const fields = {
          runId: attempt.runId,
          attemptId: attempt.id,
          worker: pool.worker,
          harness: pool.harness,
          model: pool.model,
        };
        yield* Effect.annotateCurrentSpan(fields);
        if (Option.isNone(attempt.endedAt)) {
          yield* Effect.logDebug("Skipped a capacity refusal without an end time", fields);
          return;
        }
        const refusal: Refusal = {
          attemptId: attempt.id,
          startedAt: attempt.startedAt,
          endedAt: attempt.endedAt.value,
          message: failure.message,
          resetsAt: failure.resetsAt,
        };
        const recorded = yield* Ref.modify(state, (current) => {
          const answeredAt = current.answered.get(key);
          if (answeredAt !== undefined && !DateTime.isGreaterThan(refusal.endedAt, answeredAt))
            return ["stale" as const, current];
          const existing = current.pools.get(key);
          if (existing?.refusals.some(({ attemptId }) => attemptId === attempt.id) === true) {
            // A Run registers its refusals again each time it waits; it keeps the pool it waits for.
            if (current.waiting.has(attempt.runId)) return ["known" as const, current];
            return [
              "rejoined" as const,
              { ...current, waiting: new Map(current.waiting).set(attempt.runId, { key, loop }) },
            ];
          }
          const refusals: EffectArray.NonEmptyReadonlyArray<Refusal> =
            existing === undefined
              ? [refusal]
              : EffectArray.sort(
                  EffectArray.append(existing.refusals, refusal),
                  Order.mapInput(DateTime.Order, ({ endedAt }: Refusal) => endedAt),
                );
          const probes = new Set(
            [...(existing?.probes ?? [])].filter((id) => id !== attempt.runId),
          );
          return [
            "new" as const,
            {
              ...current,
              waiting: new Map(current.waiting).set(attempt.runId, { key, loop }),
              pools: new Map(current.pools).set(key, { pool, refusals, probes }),
            },
          ];
        });
        if (recorded === "stale") {
          yield* Effect.logDebug(
            "The capacity refusal ended before the provider last answered on its pool; the Run starts without waiting for it",
            fields,
          );
          return;
        }
        if (recorded === "known") return;
        const current = yield* Ref.get(state);
        const poolState = current.pools.get(key);
        if (poolState === undefined) return;
        const wait = waitOf(current, key, poolState);
        const waitFields = {
          ...fields,
          message: failure.message,
          resetsAt: Option.getOrUndefined(Option.map(failure.resetsAt, DateTime.formatIso)),
          refusals: wait.refusals,
          since: DateTime.formatIso(wait.since),
          nextTryAt: DateTime.formatIso(wait.nextTryAt),
          waitingRuns: wait.runIds.length,
        };
        if (recorded === "new")
          yield* Effect.logWarning(
            "The provider refused the Attempt for capacity; Runs that need its pool wait, and one Attempt at a time tests it",
            waitFields,
          );
        else
          yield* Effect.logInfo(
            "The Run waits again for its pool after a capacity refusal recorded before",
            waitFields,
          );
        yield* announce(waitersOf(current, key));
      });

      /** Releases the pool of `attempt`, which is at capacity, if its provider answered it. */
      const release = Effect.fn("ProviderCapacity.answered")(function* (attempt: Attempt) {
        const pool = capacityPoolOf(attempt);
        const key = keyOf(pool);
        const now = yield* DateTime.now;
        const released = yield* Ref.modify(state, (current) => {
          const existing = current.pools.get(key);
          if (existing === undefined) return [Option.none<State>(), current];
          const { latest } = scheduleOf(existing.refusals);
          if (
            !existing.probes.has(attempt.runId) &&
            !DateTime.isGreaterThan(attempt.startedAt, latest)
          )
            return [Option.none<State>(), current];
          const next: State = {
            pools: without(current.pools, key),
            waiting: new Map([...current.waiting].filter(([, waiter]) => waiter.key !== key)),
            answered: new Map(current.answered).set(key, now),
          };
          return [Option.some(current), next];
        });
        if (Option.isNone(released)) return;
        const runs = waitersOf(released.value, key);
        yield* Effect.annotateCurrentSpan({ runId: attempt.runId, attemptId: attempt.id });
        yield* Effect.logInfo(
          "The provider answered on a pool at capacity; the Runs waiting for it start",
          {
            runId: attempt.runId,
            attemptId: attempt.id,
            worker: pool.worker,
            harness: pool.harness,
            model: pool.model,
            releasedRunIds: runs.map(([runId]) => runId),
          },
        );
        yield* announce(runs);
      });

      // Called for every model answer in a transcript, so it reads the state before it traces.
      const answered = (attempt: Attempt) =>
        Ref.get(state).pipe(
          Effect.flatMap((current) =>
            current.pools.has(keyOf(capacityPoolOf(attempt))) ? release(attempt) : Effect.void,
          ),
        );

      const claim = Effect.fn("ProviderCapacity.claim")(function* (
        runId: RunId,
        loop: LoopName,
        pool: CapacityPool,
        isForced: boolean,
      ) {
        const key = keyOf(pool);
        const now = yield* DateTime.now;
        const fields = { runId, worker: pool.worker, harness: pool.harness, model: pool.model };
        yield* Effect.annotateCurrentSpan(fields);
        yield* unforce(runId);
        const [decision, poolState, released] = yield* Ref.modify(
          state,
          (
            current,
          ): readonly [
            readonly [CapacityClaim, PoolState | undefined, ReadonlyArray<string>],
            State,
          ] => {
            // A Run elected to test another pool that got a slot on this one stops testing it.
            const released = [...current.pools].flatMap(([other, entry]) =>
              other !== key && entry.probes.has(runId) ? [other] : [],
            );
            const pools = new Map(
              [...current.pools].map(([other, entry]) => [
                other,
                released.includes(other)
                  ? { ...entry, probes: new Set([...entry.probes].filter((id) => id !== runId)) }
                  : entry,
              ]),
            );
            const existing = pools.get(key);
            if (existing === undefined)
              return [
                ["Free", undefined, released],
                dropIdle({ ...current, pools, waiting: without(current.waiting, runId) }),
              ];
            const due =
              existing.probes.has(runId) ||
              (existing.probes.size === 0 &&
                !DateTime.isLessThan(now, scheduleOf(existing.refusals).nextTryAt));
            if (!isForced && !due)
              return [
                ["Wait", existing, released],
                { ...current, pools, waiting: new Map(current.waiting).set(runId, { key, loop }) },
              ];
            const probing = { ...existing, probes: new Set([...existing.probes, runId]) };
            return [
              ["Probe", probing, released],
              dropIdle({
                ...current,
                waiting: without(current.waiting, runId),
                pools: pools.set(key, probing),
              }),
            ];
          },
        );
        const current = yield* Ref.get(state);
        const others = released.flatMap((other) => waitersOf(current, other));
        if (decision === "Free" || poolState === undefined) {
          if (released.length > 0) {
            yield* Effect.logInfo(
              "The Run elected to test a pool at capacity got a slot for another pool; the Runs waiting for the first pool elect another",
              fields,
            );
            yield* announce(others);
          }
          return decision;
        }
        const wait = waitOf(current, key, poolState);
        const waitFields = {
          ...fields,
          message: wait.message,
          since: DateTime.formatIso(wait.since),
          nextTryAt: DateTime.formatIso(wait.nextTryAt),
          probes: wait.probes,
        };
        if (decision === "Wait")
          yield* Effect.logInfo(
            "The Run's pool is at capacity; it frees its Worker slot and waits without an Attempt",
            waitFields,
          );
        else
          yield* Effect.logInfo(
            isForced
              ? "An operator retry tests the pool at capacity"
              : "The Run's Attempt tests the pool at capacity; the other Runs that need it keep waiting",
            waitFields,
          );
        yield* announce([...waitersOf(current, key), ...others]);
        return decision;
      });

      const awaitTurn = Effect.fn("ProviderCapacity.awaitTurn")(function* (runId: RunId) {
        yield* Effect.annotateCurrentSpan({ runId });
        const wake = yield* Deferred.make<void>();
        yield* Ref.update(wakes, (current) => new Map(current).set(runId, wake));
        return yield* Effect.gen(function* () {
          while (true) {
            const current = yield* Ref.get(state);
            const waiter = current.waiting.get(runId);
            const pool = waiter === undefined ? undefined : current.pools.get(waiter.key);
            if (yield* Ref.modify(forced, (runs) => [runs.has(runId), runs])) {
              yield* unforce(runId);
              yield* Effect.logInfo("An operator retry ends the Run's wait for its pool", {
                runId,
                worker: pool?.pool.worker,
                harness: pool?.pool.harness,
                model: pool?.pool.model,
              });
              return "Forced" as const;
            }
            if (pool === undefined) return "Due" as const;
            if (pool.probes.has(runId)) return "Due" as const;
            const { nextTryAt } = scheduleOf(pool.refusals);
            const now = yield* DateTime.now;
            const delay = DateTime.toEpochMillis(nextTryAt) - DateTime.toEpochMillis(now);
            if (pool.probes.size === 0 && delay <= 0) {
              // Only one waiting Run tests the pool; the others keep waiting for its answer.
              const elected = yield* Ref.modify(state, (latest) => {
                const waiting = latest.waiting.get(runId);
                const entry = waiting === undefined ? undefined : latest.pools.get(waiting.key);
                if (waiting === undefined || entry === undefined || entry.probes.size > 0)
                  return [false, latest];
                return [
                  true,
                  {
                    ...latest,
                    pools: new Map(latest.pools).set(waiting.key, {
                      ...entry,
                      probes: new Set([runId]),
                    }),
                  },
                ];
              });
              if (elected) {
                yield* Effect.logInfo("The Run's next Attempt tests its pool at capacity", {
                  runId,
                  worker: pool.pool.worker,
                  harness: pool.pool.harness,
                  model: pool.pool.model,
                });
                return "Due" as const;
              }
              continue;
            }
            const signal = yield* Ref.get(changed);
            yield* Effect.raceFirst(
              Deferred.await(wake),
              pool.probes.size === 0
                ? Effect.raceFirst(Deferred.await(signal), Effect.sleep(Duration.millis(delay)))
                : Deferred.await(signal),
            );
          }
        }).pipe(
          Effect.ensuring(
            Ref.update(wakes, (current) =>
              current.get(runId) === wake ? without(current, runId) : current,
            ),
          ),
        );
      });

      const force = Effect.fn("ProviderCapacity.force")(function* (runId: RunId) {
        yield* Effect.annotateCurrentSpan({ runId });
        yield* Ref.update(forced, (runs) => new Set([...runs, runId]));
        const wake = (yield* Ref.get(wakes)).get(runId);
        if (wake === undefined) return false;
        return yield* Deferred.succeed(wake, undefined);
      });

      const leave = Effect.fn("ProviderCapacity.leave")(function* (runId: RunId) {
        yield* Effect.annotateCurrentSpan({ runId });
        yield* unforce(runId);
        const keys = yield* Ref.modify(state, (current) => {
          const affected = [
            ...Option.toArray(
              Option.map(Option.fromUndefinedOr(current.waiting.get(runId)), ({ key }) => key),
            ),
            ...[...current.pools].flatMap(([key, pool]) => (pool.probes.has(runId) ? [key] : [])),
          ];
          if (affected.length === 0) return [affected, current];
          return [
            affected,
            dropIdle({
              ...current,
              waiting: without(current.waiting, runId),
              pools: withoutProbe(current.pools, runId),
            }),
          ];
        });
        if (keys.length === 0) return;
        yield* Effect.logDebug("The Run no longer waits for or tests a pool at capacity", {
          runId,
        });
        const current = yield* Ref.get(state);
        yield* announce(keys.flatMap((key) => waitersOf(current, key)));
      });

      const waits = Ref.get(state).pipe(
        Effect.map((current) =>
          [...current.pools]
            .map(([key, pool]) => waitOf(current, key, pool))
            .sort((left, right) => DateTime.Order(left.since, right.since)),
        ),
        Effect.withSpan("ProviderCapacity.waits"),
      );

      return { refused, answered, claim, awaitTurn, force, leave, waits };
    }),
  );
}
