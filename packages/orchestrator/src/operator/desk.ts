import type { LoadedInstance } from "@usine/config/instance";
import { AgentName } from "@usine/core/agent";
import { ProviderRetries } from "@usine/core/agent/session";
import { CycleBudgetAsk } from "@usine/core/cycle-budget";
import type { ItemKey } from "@usine/core/item";
import { LoopName } from "@usine/core/loop";
import { RepositoryName, canonicalRepositoryName } from "@usine/core/repository";
import * as RunState from "@usine/core/run/state";
import { WorkerName } from "@usine/core/worker";
import { CycleBudgets } from "@usine/engine/cycle-budget";
import { ItemProjectionReader } from "@usine/engine/item-projection";
import { LoopControl } from "@usine/engine/loop-control";
import { type RunStoreError, UnconfirmedStops } from "@usine/engine/engine";
import { type LoopSighting, RunReader, type RunSummary } from "@usine/engine/run-reader";
import {
  type TranscriptEntry,
  TranscriptPageQuery,
  TranscriptWorkerQuery,
} from "@usine/engine/transcript";
import { Context, DateTime, Effect, Layer, Match, Option, Order, Result, Schema } from "effect";
import { projectedItem } from "../board/items.ts";
import { LoopMatches } from "../loop-matches.ts";
import { PollingTriggers } from "../polling-triggers.ts";
import { type PreflightCheck, type WorkerPreflight, WorkerStatus } from "../worker-status.ts";
import {
  MachineView,
  machineView,
  ProvisioningPauseView,
  provisioningPauseView,
} from "./machines.ts";
import { AttemptView } from "./attempt.ts";
import { BoardItemLink } from "./board.ts";
import { checkView, PreflightCheckView, WorkerSlotsView } from "./configuration.ts";
import { runView, workerAccesses } from "./projection.ts";
import { RunView, UnconfirmedStopView } from "./run.ts";

/** The number of newest transcript rows the desk reads per running Attempt. */
const RECENT_TRANSCRIPT_ROWS = 200;
/** The number of closed Runs in Last outcomes. */
const LAST_OUTCOMES = 10;
/**
 * The number of recently closed Runs the desk reads before excluding those replaced before
 * starting.
 */
const CLOSED_RUNS_READ = 100;
/**
 * The number of newest Items per repository that the desk matches against the Loops, the same as a
 * Board shows.
 */
const DESK_ITEMS = 500;

/** The Attempt's Worker hasn't answered the executor's probe since `lastAnsweredAt`. */
export class WorkerSilentView extends Schema.TaggedClass<WorkerSilentView>(
  "@usine/orchestrator/WorkerSilentView",
)("WorkerSilent", { worker: WorkerName, lastAnsweredAt: Schema.String }) {}

/**
 * A session's harness is retrying its model provider: the retries in this turn, the latest report,
 * and when the first unanswered retry was recorded.
 */
export class ProviderRetryingView extends Schema.TaggedClass<ProviderRetryingView>(
  "@usine/orchestrator/ProviderRetryingView",
)("ProviderRetrying", {
  agent: AgentName,
  message: Schema.NonEmptyString,
  retries: ProviderRetries,
  since: Schema.String,
}) {}

/**
 * An open connectivity problem in an Attempt's transcript. It's a warning and never stops the
 * Attempt (ADR 0013).
 */
export const ConnectivityWarningView = Schema.Union([WorkerSilentView, ProviderRetryingView]);
export type ConnectivityWarningView = typeof ConnectivityWarningView.Type;

/** A running Attempt with its Run, Item, and recent transcript activity. */
export class RunningAttemptView extends Schema.Class<RunningAttemptView>(
  "@usine/orchestrator/RunningAttemptView",
)({
  run: RunView,
  attempt: AttemptView,
  /**
   * The Run's Item as its Board card links it, or null for a schedule Run or an Item the desk
   * didn't read.
   */
  item: Schema.NullOr(BoardItemLink),
  /**
   * When the Attempt's sessions last showed work, excluding Worker notices, pool meters, and
   * provider retries. Null if the newest rows show none.
   */
  lastActivityAt: Schema.NullOr(Schema.String),
  /** The connectivity problems still open after the newest rows. */
  warnings: Schema.Array(ConnectivityWarningView),
}) {}

/**
 * An Agent's question or blocker that suppresses the Item for the Loop until the operator answers
 * or resolves `run`, or the Item changes (ADR 0017).
 */
export class SuppressedForOperatorView extends Schema.TaggedClass<SuppressedForOperatorView>(
  "@usine/orchestrator/SuppressedForOperatorView",
)("SuppressedForOperator", { run: RunView }) {}

/**
 * `run` succeeded or was canceled on the Item's current state, so the Loop opens no other Run until
 * the state changes (ADR 0007).
 */
export class ClosedUnchangedView extends Schema.TaggedClass<ClosedUnchangedView>(
  "@usine/orchestrator/ClosedUnchangedView",
)("ClosedUnchanged", { run: RunView }) {}

/** `run` failed on the Item's current state and waits for the operator to retry it. */
export class RunFailedView extends Schema.TaggedClass<RunFailedView>(
  "@usine/orchestrator/RunFailedView",
)("RunFailed", { run: RunView }) {}

/** The Loop is paused, so its trigger opens no Run. */
export class LoopPausedView extends Schema.TaggedClass<LoopPausedView>(
  "@usine/orchestrator/LoopPausedView",
)("LoopPaused", {}) {}

/** The Item used up its cycle budget; `ask` waits for the operator to reset it. */
export class CycleBudgetUsedUpView extends Schema.TaggedClass<CycleBudgetUsedUpView>(
  "@usine/orchestrator/CycleBudgetUsedUpView",
)("CycleBudgetUsedUp", { ask: CycleBudgetAsk }) {}

/** `run` waits for the operator's approval. */
export class AwaitingApprovalView extends Schema.TaggedClass<AwaitingApprovalView>(
  "@usine/orchestrator/AwaitingApprovalView",
)("AwaitingApproval", { run: RunView }) {}

/** `run` waits for a free Worker slot. */
export class QueuedForWorkerView extends Schema.TaggedClass<QueuedForWorkerView>(
  "@usine/orchestrator/QueuedForWorkerView",
)("QueuedForWorker", {
  run: RunView,
  /**
   * The fewest Runs that take a Worker slot before `run`, or null if the scheduler doesn't
   * queue `run`: it hasn't asked for a slot yet, or this process runs no Attempts.
   */
  ahead: Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  /**
   * The machine that a provisioned Worker creates for `run`'s next Attempt, or null if none is
   * being created.
   */
  creating: Schema.NullOr(MachineView).pipe(Schema.withConstructorDefault(Effect.succeed(null))),
}) {}

/**
 * `run` starts no Attempt until the parent task of the Attempt in `stop`, on the same Loop and
 * Item, is confirmed stopped (#523).
 */
export class WaitingForStopView extends Schema.TaggedClass<WaitingForStopView>(
  "@usine/orchestrator/WaitingForStopView",
)("WaitingForStop", { run: RunView, stop: UnconfirmedStopView }) {}

/** No Event of the Loop has a Run for the Item's current state yet. The next poll acts on it. */
export class AwaitingPollView extends Schema.TaggedClass<AwaitingPollView>(
  "@usine/orchestrator/AwaitingPollView",
)("AwaitingPoll", {}) {}

/** The reason a matched Item has no running Attempt. */
export const StallReasonView = Schema.Union([
  AwaitingApprovalView,
  SuppressedForOperatorView,
  CycleBudgetUsedUpView,
  RunFailedView,
  ClosedUnchangedView,
  LoopPausedView,
  WaitingForStopView,
  QueuedForWorkerView,
  AwaitingPollView,
]);
export type StallReasonView = typeof StallReasonView.Type;

/** An Item that a Loop's trigger matches with no running Attempt, and the reason. */
export class StalledItemView extends Schema.Class<StalledItemView>(
  "@usine/orchestrator/StalledItemView",
)({
  repository: RepositoryName,
  loop: LoopName,
  item: BoardItemLink,
  reason: StallReasonView,
}) {}

/** A closed Run with its Item and close time. */
export class ClosedRunView extends Schema.Class<ClosedRunView>("@usine/orchestrator/ClosedRunView")(
  {
    run: RunView,
    /**
     * The Run's Item as its Board card links it, or null for a schedule Run or an Item the desk
     * didn't read.
     */
    item: Schema.NullOr(BoardItemLink),
    /** The Run's `closedAt`, set even for a Run canceled before any Attempt. */
    closedAt: Schema.String,
  },
) {}

/** One Worker on the desk's Workers line, with its slots and last preflight. */
export class WorkerView extends Schema.Class<WorkerView>("@usine/orchestrator/WorkerView")({
  name: WorkerName,
  /**
   * The slots as the scheduler leases them. If the scheduler runs no Attempts (as in setup mode),
   * the declared `max_concurrent_attempts` with none leased.
   */
  slots: WorkerSlotsView,
  /**
   * The newest failed check among the Worker's prerequisites and harnesses, or else its degraded
   * prerequisites, or else the newest passed or deferred check. Null before the first preflight.
   */
  preflight: Schema.NullOr(PreflightCheckView),
  /** A provisioned Worker's machines in flight, oldest first. */
  machines: Schema.Array(MachineView).pipe(Schema.withConstructorDefault(Effect.succeed([]))),
  /** A provisioned Worker's last failed machine creation, or null after a success. */
  provisioning: Schema.NullOr(ProvisioningPauseView).pipe(
    Schema.withConstructorDefault(Effect.succeed(null)),
  ),
}) {}

/**
 * When the factory last finished polling a managed repository, or null before the first poll ends.
 */
export class RepositoryPollView extends Schema.Class<RepositoryPollView>(
  "@usine/orchestrator/RepositoryPollView",
)({
  repository: RepositoryName,
  polledAt: Schema.NullOr(Schema.String),
}) {}

/**
 * The operator's desk: running Attempts, stalled matched Items, recently closed Runs, Worker slots,
 * and poll times. Needs you comes from the overview.
 */
export class DeskView extends Schema.Class<DeskView>("@usine/orchestrator/DeskView")({
  running: Schema.Array(RunningAttemptView),
  notMoving: Schema.Array(StalledItemView),
  lastOutcomes: Schema.Array(ClosedRunView),
  workers: Schema.Array(WorkerView),
  polls: Schema.Array(RepositoryPollView),
}) {}

/** The desk's facts about one Loop on one matched Item. */
interface StallFacts {
  /** The Loop's Runs on the Item, newest first. */
  readonly runs: ReadonlyArray<RunView>;
  readonly sighting: Option.Option<LoopSighting>;
  readonly paused: boolean;
  /** The Item's open cycle-budget Ask. */
  readonly ask: Option.Option<CycleBudgetAsk>;
  /** The number of Runs ahead of each Run in the scheduler's queue. */
  readonly ahead: ReadonlyMap<RunView["id"], number>;
  /** The machine being created for each Run's next Attempt. */
  readonly creating: ReadonlyMap<RunView["id"], MachineView>;
  /** The Attempt on the Item whose parent task isn't confirmed stopped, for the Loop's open Run. */
  readonly stop: Option.Option<UnconfirmedStopView>;
}

/**
 * Returns why a Loop's matched Item isn't moving, checking the engine's rules in order, or `None`
 * while an Attempt runs on the Item.
 */
const stallReason = ({
  runs,
  sighting,
  paused,
  ask,
  ahead,
  creating,
  stop,
}: StallFacts): Option.Option<StallReasonView> => {
  const open = runs.find(({ state }) => RunState.OPEN_STATE_TAGS.some((tag) => tag === state));
  if (open !== undefined) {
    // The engine doesn't stop an Attempt that already runs, but starts no other one.
    const running = open.attempts.at(-1)?.outcome === null;
    if (Option.isSome(stop) && open.state !== "Waiting" && !running)
      return Option.some(new WaitingForStopView({ run: open, stop: stop.value }));
    switch (open.state) {
      case "Running":
        return Option.none();
      case "Waiting":
        return Option.some(new AwaitingApprovalView({ run: open }));
      default:
        return Option.some(
          new QueuedForWorkerView({
            run: open,
            ahead: ahead.get(open.id) ?? null,
            creating: creating.get(open.id) ?? null,
          }),
        );
    }
  }
  if (paused) return Option.some(new LoopPausedView());
  const runOf = (runId: RunView["id"]) => Option.fromNullishOr(runs.find(({ id }) => id === runId));
  const suppressing = Option.flatMap(
    Option.flatMap(sighting, ({ suppressedBy }) => suppressedBy),
    runOf,
  );
  if (Option.isSome(suppressing)) {
    return Option.some(new SuppressedForOperatorView({ run: suppressing.value }));
  }
  if (Option.isSome(ask)) return Option.some(new CycleBudgetUsedUpView({ ask: ask.value }));
  const owner = Option.flatMap(
    Option.flatMap(sighting, ({ run }) => run),
    runOf,
  );
  if (Option.isSome(owner)) {
    return Option.some(
      owner.value.state === "Failed"
        ? new RunFailedView({ run: owner.value })
        : new ClosedUnchangedView({ run: owner.value }),
    );
  }
  return Option.some(new AwaitingPollView());
};

/**
 * The Not moving order: reasons that wait on the operator first, those that wait on the factory
 * last.
 */
const REASON_ORDER: ReadonlyArray<StallReasonView["_tag"]> = [
  "AwaitingApproval",
  "SuppressedForOperator",
  "CycleBudgetUsedUp",
  "RunFailed",
  "ClosedUnchanged",
  "LoopPaused",
  "WaitingForStop",
  "QueuedForWorker",
  "AwaitingPoll",
];

const stalledOrder = Order.combineAll([
  Order.mapInput(Order.Number, ({ reason }: StalledItemView) => REASON_ORDER.indexOf(reason._tag)),
  Order.mapInput(Order.String, ({ repository }: StalledItemView) => repository),
  Order.mapInput(Order.flip(Order.Number), ({ item }: StalledItemView) => item.number),
  Order.mapInput(Order.String, ({ loop }: StalledItemView) => loop),
]);

const isActivity = ({ direction, envelope }: TranscriptEntry): boolean => {
  const payload = envelope.payload;
  return (
    direction === "outbound" &&
    payload._tag !== "WorkerUnresponsive" &&
    payload._tag !== "WorkerResponsive" &&
    !(
      payload._tag === "SessionEvent" &&
      (payload.event._tag === "PoolRateLimitsUpdated" || payload.event._tag === "ProviderRetrying")
    )
  );
};

/**
 * Returns when the Attempt's sessions last worked and which connectivity problems are still open,
 * from its newest transcript rows.
 */
const attemptActivity = (
  entries: ReadonlyArray<TranscriptEntry>,
): Pick<RunningAttemptView, "lastActivityAt" | "warnings"> => {
  let worker: WorkerSilentView | null = null;
  const providers = new Map<string, ProviderRetryingView>();
  let lastActivity: TranscriptEntry | null = null;
  for (const entry of entries) {
    if (isActivity(entry)) lastActivity = entry;
    const payload = entry.envelope.payload;
    if (payload._tag === "WorkerUnresponsive") {
      worker = new WorkerSilentView({
        worker: payload.worker,
        lastAnsweredAt: DateTime.formatIso(payload.lastAnsweredAt),
      });
    } else if (payload._tag === "WorkerResponsive") {
      worker = null;
    } else if (payload._tag === "SessionEvent") {
      const event = payload.event;
      if (event._tag === "ProviderRetrying") {
        providers.set(
          event.session.id,
          new ProviderRetryingView({
            agent: event.session.agent,
            message: event.message,
            retries: event.retries,
            since: providers.get(event.session.id)?.since ?? DateTime.formatIso(entry.receivedAt),
          }),
        );
      } else if (
        event._tag === "ProviderRecovered" ||
        event._tag === "SessionIdle" ||
        event._tag === "SessionFinished"
      ) {
        providers.delete(event.session.id);
      }
    }
  }
  return {
    lastActivityAt: lastActivity === null ? null : DateTime.formatIso(lastActivity.receivedAt),
    warnings: [...(worker === null ? [] : [worker]), ...providers.values()],
  };
};

const checkedAt = (check: PreflightCheck): number => DateTime.toEpochMillis(check.checkedAt);

/** Returns the Worker's current preflight check, as described in `WorkerView.preflight`. */
const standingCheck = (preflight: WorkerPreflight): Option.Option<PreflightCheck> => {
  const checks = [
    ...Option.toArray(preflight.prerequisites),
    ...preflight.harnesses.map(({ check }) => check),
  ];
  const failed = checks.filter(({ _tag }) => _tag === "Failed");
  const degraded = checks.filter(({ _tag }) => _tag === "Degraded");
  return Option.fromNullishOr(
    (failed.length > 0 ? failed : degraded.length > 0 ? degraded : checks).reduce<
      PreflightCheck | undefined
    >(
      (newest, check) =>
        newest === undefined || checkedAt(check) > checkedAt(newest) ? check : newest,
      undefined,
    ),
  );
};

/**
 * Returns when a closed Run closed. The fallback (the last Attempt's end or start, else the opening
 * time) only covers the nullable field.
 */
const closedAt = (run: RunView): string => {
  const last = run.attempts.at(-1);
  return run.closedAt ?? last?.endedAt ?? last?.startedAt ?? run.openedAt;
};

/**
 * Whether the engine canceled the Run before any Attempt because a newer Event or an Item change
 * replaced it.
 */
const replacedBeforeStart = ({ run, attempts }: RunSummary): boolean =>
  attempts.length === 0 &&
  run.state._tag === "Canceled" &&
  run.state.reason._tag !== "OperatorCanceled";

const makeDesk = Effect.gen(function* () {
  const reader = yield* RunReader;
  const controls = yield* LoopControl;
  const budgets = yield* CycleBudgets;
  const itemReader = yield* ItemProjectionReader;
  const polling = yield* PollingTriggers;
  const loopMatches = yield* LoopMatches;
  const workerStatus = yield* WorkerStatus;
  const stops = yield* UnconfirmedStops;

  const recentActivity = Effect.fn("Operator.desk.recentActivity")(function* (
    attempt: AttemptView,
  ) {
    yield* Effect.annotateCurrentSpan({ attemptId: attempt.id });
    const [entries, worker] = yield* Effect.all(
      [
        reader.transcript(
          new TranscriptPageQuery({
            attemptId: attempt.id,
            before: Option.none(),
            limit: RECENT_TRANSCRIPT_ROWS,
          }),
        ),
        reader.transcript(new TranscriptWorkerQuery({ attemptId: attempt.id })),
      ],
      { concurrency: "unbounded" },
    );
    return attemptActivity([...entries, ...worker]);
  });

  const desk = Effect.fn("Operator.desk")(function* (instance: LoadedInstance) {
    const [
      summaries,
      closed,
      states,
      asks,
      slots,
      queue,
      preflights,
      latestPoll,
      unconfirmedStops,
      inFlight,
      pauses,
    ] = yield* Effect.all(
      [
        reader.list({ closedLimit: 0 }),
        reader.closed({ limit: CLOSED_RUNS_READ }),
        controls.states,
        budgets.asks(),
        workerStatus.slots,
        workerStatus.queue,
        workerStatus.preflights,
        polling.latest,
        stops.list,
        workerStatus.machines,
        workerStatus.provisioning,
      ] as const,
      { concurrency: "unbounded" },
    );
    const machineViews = inFlight.map(machineView);
    const creating = new Map(
      machineViews.flatMap((machine) =>
        machine.state === "creating" && machine.runId !== null
          ? [[machine.runId, machine] as const]
          : [],
      ),
    );
    const ahead = new Map(queue.map(({ runId, ahead }) => [runId, ahead]));
    const paused = new Set(states.filter((state) => state.paused).map((state) => state.loop));
    const access = workerAccesses(instance.config.workers);
    const repositories = yield* Effect.forEach(
      instance.config.repos,
      (repository) =>
        Effect.gen(function* () {
          const items = yield* itemReader.list(repository.name, { limit: DESK_ITEMS });
          const matches = yield* loopMatches.matching(instance, repository, items);
          return { repository, items, matches };
        }),
      { concurrency: 4 },
    );

    const links = new Map<ItemKey, BoardItemLink>();
    for (const { items } of repositories) {
      for (const stored of items) {
        const projected = yield* Effect.result(projectedItem(stored));
        // The Board reports an Item it can't project in Needs you.
        if (Result.isFailure(projected)) continue;
        const { itemKey, kind, number, title, url, state } = projected.success;
        links.set(itemKey, new BoardItemLink({ itemKey, kind, number, title, url, state }));
      }
    }

    const matches = repositories.flatMap(({ matches: repositoryMatches }) => repositoryMatches);
    const matchedKeys = [...new Set(matches.map(({ item }) => item.itemKey))];
    const [history, sightings] = yield* Effect.all(
      [reader.forItems(matchedKeys), reader.sightings(matchedKeys)] as const,
      { concurrency: "unbounded" },
    );
    const runs = new Map(
      [...summaries, ...history].map((summary) => [
        summary.run.id,
        runView(summary, paused, access),
      ]),
    );
    const newestFirst = [...runs.values()].sort(
      (left, right) =>
        right.openedAt.localeCompare(left.openedAt) || right.id.localeCompare(left.id),
    );
    /** Returns the unconfirmed stop on `itemKey`, if the desk read its Run. */
    const stopOn = (itemKey: ItemKey): Option.Option<UnconfirmedStopView> =>
      Option.flatMap(
        Option.fromNullishOr(unconfirmedStops.find((stop) => stop.itemKey === itemKey)),
        (stop) =>
          Option.map(
            Option.fromNullishOr(
              runs.get(stop.runId)?.attempts.find(({ id }) => id === stop.attemptId),
            ),
            ({ number }) =>
              new UnconfirmedStopView({
                runId: stop.runId,
                attemptNumber: number,
                worker: stop.worker,
              }),
          ),
      );

    const notMoving: Array<StalledItemView> = [];
    for (const { loop, item } of matches) {
      const link = links.get(item.itemKey);
      if (link === undefined) continue;
      const reason = stallReason({
        runs: newestFirst.filter((run) => run.loop === loop.name && run.itemKey === item.itemKey),
        sighting: Option.fromNullishOr(
          sightings.find(
            (sighting) => sighting.loop === loop.name && sighting.itemKey === item.itemKey,
          ),
        ),
        paused: paused.has(loop.name),
        ask: Option.fromNullishOr(asks.find(({ itemKey }) => itemKey === item.itemKey)),
        ahead,
        creating,
        stop: stopOn(item.itemKey),
      });
      if (Option.isNone(reason)) continue;
      yield* Effect.logDebug("Matched Item is not moving", {
        repository: item.repository,
        loop: loop.name,
        item: item.number,
        reason: reason.value._tag,
        ...Match.valueTags(reason.value, {
          AwaitingApproval: ({ run }) => ({ runId: run.id }),
          SuppressedForOperator: ({ run }) => ({ runId: run.id }),
          CycleBudgetUsedUp: ({ ask }) => ({ askId: ask.id }),
          RunFailed: ({ run }) => ({ runId: run.id }),
          ClosedUnchanged: ({ run }) => ({ runId: run.id, state: run.state }),
          LoopPaused: () => ({}),
          WaitingForStop: ({ run, stop }) => ({
            runId: run.id,
            unstoppedRunId: stop.runId,
            attemptNumber: stop.attemptNumber,
            worker: stop.worker,
          }),
          QueuedForWorker: ({ run, ahead }) => ({ runId: run.id, ahead }),
          AwaitingPoll: () => ({}),
        }),
      });
      notMoving.push(
        new StalledItemView({
          repository: item.repository,
          loop: loop.name,
          item: link,
          reason: reason.value,
        }),
      );
    }

    const running = yield* Effect.forEach(
      newestFirst.flatMap((run) => {
        const attempt = run.attempts.at(-1);
        return run.state === "Running" && attempt !== undefined && attempt.outcome === null
          ? [{ run, attempt }]
          : [];
      }),
      ({ run, attempt }) =>
        Effect.map(
          recentActivity(attempt),
          (activity) =>
            new RunningAttemptView({
              run,
              attempt,
              item: links.get(run.itemKey) ?? null,
              ...activity,
            }),
        ),
      { concurrency: 4 },
    );

    const lastOutcomes = closed
      .filter((summary) => !replacedBeforeStart(summary))
      .map((summary) => {
        const run = runView(summary, paused, access);
        return new ClosedRunView({
          run,
          item: links.get(run.itemKey) ?? null,
          closedAt: closedAt(run),
        });
      })
      .sort((left, right) => right.closedAt.localeCompare(left.closedAt))
      .slice(0, LAST_OUTCOMES);

    const slotsByWorker = new Map(slots.map((slot) => [slot.worker, slot]));
    const preflightByWorker = new Map(preflights.map((preflight) => [preflight.worker, preflight]));
    const declared = new Set(instance.config.workers.map(({ name }) => name));
    const workers = [
      ...instance.config.workers.map(({ name }) => name),
      ...slots.map(({ worker }) => worker).filter((worker) => !declared.has(worker)),
    ].map((name) => {
      const slot = slotsByWorker.get(name);
      const preflight = preflightByWorker.get(name);
      return new WorkerView({
        name,
        slots: new WorkerSlotsView({
          capacity:
            slot?.capacity ??
            instance.config.workers.find((worker) => worker.name === name)?.maxConcurrentAttempts ??
            0,
          leased: slot?.leased ?? 0,
        }),
        preflight: Option.getOrNull(
          Option.map(Option.flatMap(Option.fromNullishOr(preflight), standingCheck), checkView),
        ),
        machines: machineViews.filter((machine) => machine.worker === name),
        provisioning: Option.getOrNull(
          Option.map(
            Option.fromNullishOr(pauses.find((pause) => pause.worker === name)),
            provisioningPauseView,
          ),
        ),
      });
    });

    const completed = Option.match(latestPoll, {
      onNone: () => [],
      onSome: ({ repositoryPolls }) => repositoryPolls,
    });
    const polls = instance.config.repos.map(({ name }) => {
      const poll = completed.find(
        ({ repository }) => canonicalRepositoryName(repository) === canonicalRepositoryName(name),
      );
      return new RepositoryPollView({
        repository: name,
        polledAt: poll === undefined ? null : DateTime.formatIso(poll.completedAt),
      });
    });

    yield* Effect.logDebug("Built the operator desk", {
      running: running.length,
      matches: matches.length,
      notMoving: notMoving.length,
      lastOutcomes: lastOutcomes.length,
      workers: workers.length,
    });
    return new DeskView({
      running,
      notMoving: [...notMoving].sort(stalledOrder),
      lastOutcomes,
      workers,
      polls,
    });
  });

  return { desk };
});

/** Builds the operator's desk from the engine's stores, the Loop matches, and the scheduler's slots. */
export class OperatorDesk extends Context.Service<
  OperatorDesk,
  {
    /** Returns the instance's desk, as described in `OperatorObservation.desk`. */
    readonly desk: (instance: LoadedInstance) => Effect.Effect<DeskView, RunStoreError>;
  }
>()("@usine/orchestrator/OperatorDesk") {
  static readonly layer = Layer.effect(OperatorDesk, makeDesk).pipe(
    Layer.provide(LoopMatches.layer),
  );
}
