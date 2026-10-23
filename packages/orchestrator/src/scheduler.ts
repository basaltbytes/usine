import type { UsineConfig, Worker as ConfigWorker } from "@usine/config/factory";
import type { LoadedInstance } from "@usine/config/instance";
import { resolveParentEffort } from "@usine/core/agent";
import type { BrainSpec } from "@usine/core/agent/brain";
import { AgentFailure, InfraFailure } from "@usine/core/attempt/failure";
import type { AttemptId } from "@usine/core/attempt";
import { salvageRefFor } from "@usine/core/attempt/salvage";
import { BotLogin, WorkerName } from "@usine/core/worker";
import { CheckoutRequest, Executor, ExecutorError, ExecutorOperationError } from "@usine/executor";
import { StepExecutor, type WorkerLease } from "@usine/engine/step-executor";
import { GitHubApp, type Installation } from "@usine/github/github-app";
import {
  Array as EffectArray,
  Context,
  DateTime,
  Deferred,
  Effect,
  Exit,
  Layer,
  Match,
  Option,
  Order,
  Ref,
  Schema,
  Semaphore,
  TxPriorityQueue,
  TxRef,
} from "effect";
import {
  agentsWithNewBrains,
  type RestartChange,
  type WorkersChange,
  workersChange,
} from "./current-instance/changes.ts";
import {
  CurrentInstance,
  reloadPreflightFailed,
  restartRequired,
  type WorkerReload,
} from "./current-instance/current-instance.ts";
import { recordPreflight, unchecked, type WorkerPreflight, WorkerStatus } from "./worker-status.ts";

export class UnsupportedWorkerError extends Schema.TaggedError<UnsupportedWorkerError>(
  "@usine/orchestrator/UnsupportedWorkerError",
)("UnsupportedWorkerError", {
  worker: WorkerName,
  kind: Schema.String,
}) {}

type ReservationState =
  | { readonly _tag: "Pending" }
  | { readonly _tag: "Assigned"; readonly lease: WorkerLease }
  | { readonly _tag: "Canceled" };

interface Reservation {
  readonly deferred: Deferred.Deferred<WorkerLease>;
  /**
   * If set, the only Worker the lease can come from: the Worker of the Run's reattached Attempt.
   */
  readonly worker: Option.Option<WorkerName>;
  readonly eventTime: number;
  readonly order: number;
  readonly state: Ref.Ref<ReservationState>;
}

// Reservations for a specific Worker (Attempts already running there) go first; otherwise, the Run
// whose Event arrived first goes first.
const reservationOrder = Order.combineAll([
  Order.mapInput(Order.Boolean, (reservation: Reservation) => Option.isNone(reservation.worker)),
  Order.mapInput(Order.Number, (reservation: Reservation) => reservation.eventTime),
  Order.mapInput(Order.Number, (reservation: Reservation) => reservation.order),
]);

interface WorkerSlots {
  /** The maximum concurrent Attempts on the Worker, or zero after a reload removed it. */
  readonly capacity: number;
  /** The number of Attempts with a lease on the Worker. */
  readonly leased: number;
}

/**
 * The slots of each Worker in `usine.yaml` order, then of each removed Worker until its last
 * Attempt ends.
 */
type SlotPool = ReadonlyMap<WorkerName, WorkerSlots>;

const slotPoolOf = (workers: ReadonlyArray<ConfigWorker>, previous: SlotPool): SlotPool => {
  const declared = new Set(workers.map(({ name }) => name));
  return new Map([
    ...workers.map(
      ({ name, maxConcurrentAttempts }) =>
        [
          name,
          { capacity: maxConcurrentAttempts, leased: previous.get(name)?.leased ?? 0 },
        ] as const,
    ),
    ...[...previous]
      .filter(([name, { leased }]) => !declared.has(name) && leased > 0)
      .map(([name, { leased }]) => [name, { capacity: 0, leased }] as const),
  ]);
};

const isFree = (pool: SlotPool, worker: WorkerName): boolean => {
  const slots = pool.get(worker);
  return slots !== undefined && slots.leased < slots.capacity;
};

/**
 * Returns the Worker with a free slot for `reservation`: its specified Worker, or else the first
 * free one.
 */
const workerFor = (pool: SlotPool, reservation: Reservation): Option.Option<WorkerName> =>
  Option.match(reservation.worker, {
    onNone: () => Option.fromNullishOr([...pool.keys()].find((worker) => isFree(pool, worker))),
    onSome: (worker) => (isFree(pool, worker) ? Option.some(worker) : Option.none()),
  });

const withLeased = (pool: SlotPool, worker: WorkerName, change: number): SlotPool => {
  const slots = pool.get(worker);
  if (slots === undefined) return pool;
  return new Map(pool).set(worker, { ...slots, leased: slots.leased + change });
};

type SlotRelease =
  | { readonly _tag: "Freed" }
  | { readonly _tag: "Retired"; readonly running: number; readonly slots: number }
  | { readonly _tag: "Dropped" };

const releasedFrom = (pool: SlotPool, worker: WorkerName): [SlotRelease, SlotPool] => {
  const slots = pool.get(worker);
  if (slots === undefined) return [{ _tag: "Dropped" }, pool];
  if (slots.capacity === 0 && slots.leased <= 1) {
    const next = new Map(pool);
    next.delete(worker);
    return [{ _tag: "Dropped" }, next];
  }
  const next = withLeased(pool, worker, -1);
  return slots.leased > slots.capacity
    ? [{ _tag: "Retired", running: slots.leased - 1, slots: slots.capacity }, next]
    : [{ _tag: "Freed" }, next];
};

// Only errors that a retry can avoid become the `InfraFailure` that the engine retries.
const asAttemptFailure = (error: ExecutorError): AgentFailure | InfraFailure =>
  Match.valueTags(error, {
    WorkerCapabilityError: ({ message }) => new AgentFailure({ message }),
    CredentialUnavailableError: ({ reason, message }) =>
      reason === "refused"
        ? new AgentFailure({ message })
        : new InfraFailure({ message, cause: error }),
    ExecutorOperationError: ({ operation, message }) =>
      new InfraFailure({ message: `Executor ${operation} failed: ${message}`, cause: error }),
  });

// The operation error has no Worker field, and reports must include the Worker.
const namingWorker =
  (worker: WorkerName) =>
  (error: ExecutorError): ExecutorError =>
    error._tag === "ExecutorOperationError"
      ? new ExecutorOperationError({
          operation: error.operation,
          message: `Worker ${worker}: ${error.message}`,
          cause: error.cause,
        })
      : error;

const validateWorkers = (
  kind: ConfigWorker["kind"],
  workers: ReadonlyArray<ConfigWorker>,
): Effect.Effect<ReadonlyArray<ConfigWorker>, UnsupportedWorkerError> => {
  const unsupported = workers.find((worker) => worker.kind !== kind);
  return unsupported === undefined
    ? Effect.succeed(workers)
    : new UnsupportedWorkerError({ worker: unsupported.name, kind: unsupported.kind });
};

const brainLabel = ({ harness, model, effort }: BrainSpec) => `${harness}/${model}/${effort}`;

/** The login that exe.dev Workers write to GitHub as, through exe.dev's integration (ADR 0011). */
const EXE_DEV_BOT_LOGIN = BotLogin.make("exe-dev-github-integration[bot]");
const decodeBotLogin = Schema.decodeUnknownOption(BotLogin);

/**
 * The Worker set of an executor that connects only to the Workers it was given, such as the SSH
 * executor.
 */
export interface ExecutorWorkers {
  /**
   * Adds `worker` to the executor before its preflight. On failure, the reload fails with
   * `ReloadPreflightError`.
   */
  readonly add: (worker: ConfigWorker) => Effect.Effect<void, ExecutorError>;
  /**
   * Removes `worker` once no Attempt runs on it: a Worker removed by a reload, or one added by a
   * reload whose preflight failed.
   */
  readonly remove: (worker: WorkerName) => Effect.Effect<void>;
}

export interface StepExecutorOptions {
  /**
   * The executor's Worker set, which the scheduler updates on each reload. If omitted, the executor
   * runs any Worker of its kind by name, like the local executor.
   */
  readonly workers?: ExecutorWorkers;
}

/** The Worker set of an executor that runs any Worker of its kind by name. */
const anyWorker: ExecutorWorkers = { add: () => Effect.void, remove: () => Effect.void };

/**
 * Schedules Attempts FIFO over the Workers and adapts the Executor to the engine's `StepExecutor`
 * port. Reservations for a specific Worker go first (#177), and a removed Worker stays until its
 * last Attempt ends.
 */
export const stepExecutorLayer = (
  config: UsineConfig,
  brains: ReadonlyArray<BrainSpec>,
  options: StepExecutorOptions = {},
): Layer.Layer<
  StepExecutor | WorkerStatus,
  ExecutorError | UnsupportedWorkerError,
  CurrentInstance | Executor | GitHubApp
> =>
  Layer.effectContext(
    Effect.gen(function* () {
      const executor = yield* Executor;
      const instances = yield* CurrentInstance;
      const app = yield* GitHubApp;
      const workers = yield* validateWorkers(executor.kind, config.workers);
      const pool = yield* TxRef.make(slotPoolOf(workers, new Map()));
      const pending = yield* TxPriorityQueue.empty(reservationOrder);
      const nextOrder = yield* Ref.make(0);
      const preflights = yield* Ref.make(new Map<WorkerName, WorkerPreflight>());
      const executorWorkers = options.workers ?? anyWorker;
      // Every change to the executor's Workers takes this permit, so a removal never undoes an
      // addition.
      const membership = yield* Semaphore.make(1);
      const adding = yield* Ref.make<ReadonlySet<WorkerName>>(new Set());

      const recordPreflightExit = Effect.fn("WorkerScheduler.recordPreflight")(function* (
        worker: WorkerName,
        roster: ReadonlyArray<BrainSpec>,
        exit: Exit.Exit<void, ExecutorError>,
      ) {
        const failure = Exit.findErrorOption(exit);
        // An interrupted or defective preflight gives no information about the Worker.
        if (Exit.isFailure(exit) && Option.isNone(failure)) return;
        const checkedAt = yield* DateTime.now;
        yield* Ref.update(preflights, (current) =>
          new Map(current).set(
            worker,
            recordPreflight(current.get(worker) ?? unchecked(worker), roster, checkedAt, failure),
          ),
        );
      });

      /**
       * Runs `before`, then the Worker's preflight, and records both outcomes as the Worker's
       * preflight.
       */
      const preflightWorker = (
        worker: ConfigWorker,
        roster: ReadonlyArray<BrainSpec>,
        before: Effect.Effect<void, ExecutorError> = Effect.void,
      ) =>
        before.pipe(
          Effect.andThen(executor.preflight(worker.name, roster, worker.maxConcurrentAttempts)),
          Effect.mapError(namingWorker(worker.name)),
          Effect.onExit((exit) => recordPreflightExit(worker.name, roster, exit)),
        );

      /**
       * Removes `worker` from the executor unless the scheduler has it or a reload is adding it.
       * Callers must hold `membership`.
       */
      const removeUnused = Effect.fn("WorkerScheduler.removeFromExecutor")(function* (
        worker: WorkerName,
      ) {
        yield* Effect.annotateCurrentSpan({ worker });
        const scheduled = (yield* TxRef.get(pool)).has(worker);
        const added = (yield* Ref.get(adding)).has(worker);
        if (scheduled || added) {
          yield* Effect.logDebug(
            "The Worker stays with the executor, because the scheduler has it or a reload is adding it",
            { worker, scheduled, added },
          );
          return;
        }
        yield* executorWorkers.remove(worker);
      });

      /**
       * Ends a reload's addition of `added` and removes each Worker that the scheduler doesn't
       * have.
       */
      const settleAdded = (added: ReadonlySet<WorkerName>, removed: ReadonlyArray<WorkerName>) =>
        membership.withPermit(
          Ref.update(
            adding,
            (current) => new Set([...current].filter((name) => !added.has(name))),
          ).pipe(Effect.andThen(Effect.forEach(removed, removeUnused, { discard: true }))),
        );

      const unservedChange = (worker: ConfigWorker): Option.Option<RestartChange> =>
        worker.kind === executor.kind
          ? Option.none()
          : Option.some({
              block: "workers",
              field: `workers.${worker.name}.kind`,
              reason: `Worker ${worker.name} is ${worker.kind}, and the running Workers are ${executor.kind}`,
            });

      const applyWorkers = Effect.fn("WorkerScheduler.applyWorkers")(function* (
        change: WorkersChange,
        declared: ReadonlyArray<ConfigWorker>,
      ) {
        const before = yield* TxRef.modify(pool, (current) => [
          current,
          slotPoolOf(declared, current),
        ]);
        const running = (worker: WorkerName) => before.get(worker)?.leased ?? 0;
        yield* Effect.forEach(change.resized, ({ worker, from }) =>
          Effect.logInfo("Worker slots resized by a reload; running Attempts continue", {
            worker: worker.name,
            slotsBefore: from,
            slotsAfter: worker.maxConcurrentAttempts,
            running: running(worker.name),
          }),
        );
        yield* Effect.forEach(change.added, (worker) =>
          Effect.logInfo("Worker added by a reload; it takes Attempts now", {
            worker: worker.name,
            slots: worker.maxConcurrentAttempts,
          }),
        );
        yield* Effect.forEach(change.removed, ({ name }) =>
          running(name) === 0
            ? Effect.logInfo(
                "Worker removed by a reload; it runs no Attempt, so it leaves the scheduler now",
                { worker: name },
              )
            : Effect.logInfo(
                "Worker removed by a reload; it takes no new Attempt, and its running Attempts finish",
                { worker: name, running: running(name) },
              ),
        );
        yield* settleAdded(
          new Set(change.added.map(({ name }) => name)),
          change.removed.map(({ name }) => name),
        );
      });

      const prepareReload: WorkerReload = Effect.fn("WorkerScheduler.prepareReload")(function* (
        running: LoadedInstance,
        loaded: LoadedInstance,
      ) {
        const change = workersChange(running.config.workers, loaded.config.workers);
        const restart = [
          ...change.restart,
          ...EffectArray.getSomes(change.added.map(unservedChange)),
        ];
        if (EffectArray.isReadonlyArrayNonEmpty(restart)) {
          return yield* restartRequired(restart);
        }
        const agents = agentsWithNewBrains(running, loaded);
        const agentNames = agents.map(({ name }) => name);
        const newBrains = EffectArray.dedupe(agents.map(({ agent }) => agent.brain));
        const roster = EffectArray.dedupe(loaded.agents.map(({ agent }) => agent.brain));
        const wholeRoster = new Set([
          ...change.added.map(({ name }) => name),
          ...change.resized
            .filter(({ worker, from }) => worker.maxConcurrentAttempts > from)
            .map(({ worker }) => worker.name),
        ]);
        const checks = loaded.config.workers.flatMap((worker) =>
          wholeRoster.has(worker.name)
            ? [{ worker, brains: roster }]
            : newBrains.length > 0
              ? [{ worker, brains: newBrains }]
              : [],
        );
        yield* Effect.annotateCurrentSpan({ agents: agentNames, workers: [...wholeRoster] });
        if (checks.length === 0) {
          yield* Effect.logDebug(
            "The reload adds no Worker, slot, or brain, so it runs no Worker preflight",
          );
          return applyWorkers(change, loaded.config.workers);
        }
        const added = new Set(change.added.map(({ name }) => name));
        yield* membership.withPermit(
          Ref.update(adding, (current) => new Set([...current, ...added])),
        );
        yield* Effect.logInfo("Preflighting the Workers, slots, and brains the reload adds", {
          agents: agentNames,
          brains: newBrains.map(brainLabel),
          workers: [...wholeRoster],
        });
        // Add the Worker to the executor first, so its preflight can connect to its machine.
        yield* Effect.forEach(
          checks,
          ({ worker, brains }) =>
            added.has(worker.name)
              ? preflightWorker(worker, brains, executorWorkers.add(worker))
              : preflightWorker(worker, brains),
          { concurrency: "unbounded", discard: true },
        ).pipe(
          Effect.mapError((cause) => reloadPreflightFailed(agentNames, [...wholeRoster], cause)),
          Effect.onExit((exit) =>
            Exit.isFailure(exit) ? settleAdded(added, [...added]) : Effect.void,
          ),
        );
        return applyWorkers(change, loaded.config.workers);
      });

      yield* instances.registerWorkers(prepareReload);
      // A reload can change the roster after the caller read `brains` and before the registration.
      const { agents } = yield* instances.get;
      const startupRoster = EffectArray.dedupe([
        ...brains,
        ...agents.map(({ agent }) => agent.brain),
      ]);
      yield* Effect.forEach(workers, (worker) => preflightWorker(worker, startupRoster), {
        concurrency: "unbounded",
        discard: true,
      }).pipe(Effect.withSpan("WorkerScheduler.preflight"));

      const releaseSlot = (worker: WorkerName) =>
        TxRef.modify(pool, (current) => releasedFrom(current, worker)).pipe(
          Effect.flatMap((release) =>
            Match.valueTags(release, {
              Freed: () => Effect.logDebug("Worker slot released", { worker }),
              Retired: ({ running, slots }) =>
                Effect.logInfo(
                  "An Attempt ended on a Worker that runs more Attempts than it has slots; its slot retires",
                  { worker, running, slots },
                ),
              Dropped: () =>
                Effect.logInfo(
                  "The last Attempt on a removed Worker ended; the Worker leaves the scheduler",
                  { worker },
                ).pipe(Effect.andThen(membership.withPermit(removeUnused(worker)))),
            }),
          ),
        );

      const makeLease = Effect.fn("WorkerScheduler.makeLease")(function* (worker: WorkerName) {
        const released = yield* Ref.make(false);
        return {
          worker,
          release: Ref.modify(released, (done) => [!done, true] as const).pipe(
            Effect.flatMap((first) => (first ? releaseSlot(worker) : Effect.void)),
          ),
        } satisfies WorkerLease;
      });

      // Retries until a free slot can take a waiting reservation, then takes both. A reservation
      // whose Worker has no free slot doesn't block the ones behind it.
      const nextAssignment = Effect.tx(
        Effect.gen(function* () {
          const current = yield* TxRef.get(pool);
          const next = EffectArray.findFirst(
            yield* TxPriorityQueue.toArray(pending),
            (reservation) =>
              Option.map(workerFor(current, reservation), (worker) => ({ worker, reservation })),
          );
          if (Option.isNone(next)) return yield* Effect.txRetry;
          const { worker, reservation } = next.value;
          yield* TxPriorityQueue.removeIf(pending, (waiting) => waiting === reservation);
          yield* TxRef.set(pool, withLeased(current, worker, 1));
          return next.value;
        }),
      );

      const dispatch = Effect.forever(
        Effect.gen(function* () {
          const { worker, reservation } = yield* nextAssignment;
          const lease = yield* makeLease(worker);
          const assign = yield* Ref.modify(reservation.state, (state) =>
            state._tag === "Pending"
              ? [true, { _tag: "Assigned", lease } satisfies ReservationState]
              : [false, state],
          );
          if (assign) {
            yield* Effect.logDebug("Worker slot assigned", { worker });
            yield* Deferred.succeed(reservation.deferred, lease);
          } else {
            yield* lease.release;
          }
        }),
      );
      yield* Effect.forkScoped(dispatch);

      const occupy: StepExecutor["Service"]["occupy"] = Effect.fn("WorkerScheduler.occupy")(
        function* (worker) {
          yield* Effect.annotateCurrentSpan({ worker });
          // The Attempt runs on the Worker even without a free slot, so count it now. A slot over
          // capacity retires when an Attempt there ends.
          const slots = yield* TxRef.modify(
            pool,
            (current) => [current.get(worker), withLeased(current, worker, 1)] as const,
          );
          if (slots === undefined) {
            yield* Effect.logWarning(
              "An Attempt already runs on a Worker the scheduler does not have; it occupies no slot, and that Worker takes no new Attempt",
              { worker },
            );
            return { worker, release: Effect.void } satisfies WorkerLease;
          }
          const fields = { worker, running: slots.leased + 1, slots: slots.capacity };
          if (slots.leased < slots.capacity)
            yield* Effect.logInfo(
              "An Attempt that already runs on the Worker occupies a slot",
              fields,
            );
          else
            yield* Effect.logWarning(
              "An Attempt that already runs on the Worker occupies a slot beyond its max_concurrent_attempts; the Worker takes no new Attempt until enough of its Attempts end",
              fields,
            );
          return yield* makeLease(worker);
        },
      );

      const reserve: StepExecutor["Service"]["reserve"] = Effect.fn("WorkerScheduler.reserve")(
        function* (submission, worker) {
          const run = { loop: submission.loop, itemKey: submission.itemKey };
          yield* Effect.annotateCurrentSpan(run);
          if (Option.isSome(worker)) yield* Effect.annotateCurrentSpan({ worker: worker.value });
          const deferred = yield* Deferred.make<WorkerLease>();
          const state = yield* Ref.make<ReservationState>({ _tag: "Pending" });
          const reservation: Reservation = {
            deferred,
            worker,
            eventTime: DateTime.toEpochMillis(submission.event.receivedAt),
            order: yield* Ref.getAndUpdate(nextOrder, (value) => value + 1),
            state,
          };
          yield* TxPriorityQueue.offer(pending, reservation);
          const fields = { ...run, queued: yield* TxPriorityQueue.size(pending) };
          if (Option.isNone(worker)) yield* Effect.logInfo("Run waits for a worker slot", fields);
          else if (((yield* TxRef.get(pool)).get(worker.value)?.capacity ?? 0) > 0)
            yield* Effect.logInfo(
              "Run waits for a slot on the Worker its reattached Attempt runs on",
              { ...fields, worker: worker.value },
            );
          else
            yield* Effect.logWarning(
              "Run waits for a slot on the Worker its reattached Attempt runs on, which usine.yaml does not declare; it waits until a reload declares that Worker again or the Run is canceled",
              { ...fields, worker: worker.value },
            );
          return yield* Deferred.await(deferred).pipe(
            Effect.onInterrupt(() =>
              Ref.modify(state, (current) =>
                current._tag === "Assigned"
                  ? [Option.some(current.lease), { _tag: "Canceled" } satisfies ReservationState]
                  : [Option.none<WorkerLease>(), { _tag: "Canceled" } satisfies ReservationState],
              ).pipe(
                // Remove a canceled reservation from the queue, so one whose Worker never frees a
                // slot doesn't stay there.
                Effect.tap(() =>
                  TxPriorityQueue.removeIf(pending, (waiting) => waiting === reservation),
                ),
                Effect.flatMap(
                  Option.match({ onNone: () => Effect.void, onSome: (lease) => lease.release }),
                ),
              ),
            ),
          );
        },
      );

      // If the login can't be read, harvesting asks GitHub; the Attempt never fails for this.
      const botLoginFor = Effect.fn("WorkerScheduler.botLogin")(function* (attemptId: AttemptId) {
        if (executor.kind === "exe.dev") return Option.some(EXE_DEV_BOT_LOGIN);
        const installation = yield* app.installation().pipe(
          Effect.map(Option.some),
          Effect.catch((error) =>
            Effect.logWarning(
              "Could not read the App's installation; harvesting will ask GitHub for the login of the Attempt's credential",
              { attemptId, errorTag: error._tag, message: error.message },
            ).pipe(Effect.as(Option.none<Installation>())),
          ),
        );
        if (Option.isNone(installation)) return Option.none<BotLogin>();
        const { appSlug } = installation.value;
        // GitHub's REST API names an App's bot `<slug>[bot]`; its GraphQL API drops the suffix.
        const login = decodeBotLogin(`${appSlug}[bot]`);
        if (Option.isNone(login))
          yield* Effect.logWarning(
            "The App's slug does not form a bot login; harvesting will ask GitHub for the login of the Attempt's credential",
            { attemptId, appSlug },
          );
        return login;
      });

      const execute: StepExecutor["Service"]["execute"] = Effect.fn("WorkerScheduler.execute")(
        function* (execution, io) {
          yield* Effect.annotateCurrentSpan({
            attemptId: execution.attempt.id,
            runId: execution.run.id,
            worker: execution.attempt.worker,
            loop: execution.run.loop,
            permissions: execution.permissions,
            reattach: execution.reattach,
          });
          const { settings } = (yield* instances.get).config;
          const botLogin = yield* botLoginFor(execution.attempt.id);
          const prepared = yield* executor
            .prepare(
              new CheckoutRequest({
                attemptId: execution.attempt.id,
                worker: execution.attempt.worker,
                repository: execution.repository,
                loop: execution.run.loop,
                permissions: execution.permissions,
                revision: execution.revision,
                payload: execution.event.payload,
                task: execution.task,
                agent: execution.agent,
                parentModel: execution.parentModel,
                maxChildren: settings.maxChildren,
                maxAttemptMinutes: settings.maxAttemptMinutes,
                maxAttemptTokens: settings.maxAttemptTokens,
                parentEffort: resolveParentEffort(execution.agent, settings.parentEffort),
                salvageRef: salvageRefFor(execution.run.id, execution.attempt.number),
                resume: execution.resume,
                reattach: execution.reattach,
                botLogin,
              }),
            )
            .pipe(
              Effect.tapError((error) =>
                error._tag === "CredentialUnavailableError"
                  ? Effect.logWarning(
                      error.reason === "refused"
                        ? "The Attempt's repository access was refused; the Attempt fails without an automatic retry"
                        : "The Attempt's repository access could not be obtained now; the Attempt fails with an infrastructure failure, which is retried",
                      {
                        attemptId: execution.attempt.id,
                        worker: execution.attempt.worker,
                        repository: error.repository,
                        reason: error.reason,
                        message: error.message,
                      },
                    )
                  : Effect.void,
              ),
              Effect.mapError(asAttemptFailure),
            );
          // The engine reconciles a checkout kept for a reattachment until preparation acquires it;
          // from here the executor releases it.
          yield* io.checkoutAcquired;
          return yield* prepared.launch(io);
        },
        Effect.scoped,
      );

      const interrupt: StepExecutor["Service"]["interrupt"] = (attemptId) =>
        executor.cancel(attemptId).pipe(Effect.mapError(asAttemptFailure));

      const status = WorkerStatus.of({
        slots: TxRef.get(pool).pipe(
          Effect.map((current) =>
            [...current].map(([worker, { capacity, leased }]) => ({ worker, capacity, leased })),
          ),
        ),
        preflights: Ref.get(preflights).pipe(Effect.map((current) => [...current.values()])),
      });

      const stepExecutor = StepExecutor.of({
        workers: TxRef.get(pool).pipe(Effect.map((current) => [...current.keys()])),
        execute,
        interrupt,
        isLive: executor.isLive,
        outcome: executor.outcome,
        reserve,
        occupy,
        intervene: executor.intervene,
        recover: (attempt, record) =>
          executor
            .recover(attempt, record)
            .pipe(
              Effect.catchIf(Schema.is(ExecutorError), (error) =>
                Effect.fail(asAttemptFailure(error)),
              ),
            ),
      });
      return Context.make(StepExecutor, stepExecutor).pipe(Context.add(WorkerStatus, status));
    }),
  );
