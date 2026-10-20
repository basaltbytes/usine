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
  TxPriorityQueue,
  TxRef,
} from "effect";
import {
  agentsWithNewBrains,
  changedWorkerSettings,
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
  readonly eventTime: number;
  readonly order: number;
  readonly state: Ref.Ref<ReservationState>;
}

const reservationOrder = Order.combine(
  Order.mapInput(Order.Number, (reservation: Reservation) => reservation.eventTime),
  Order.mapInput(Order.Number, (reservation: Reservation) => reservation.order),
);

interface WorkerSlots {
  /** How many Attempts the Worker may run at the same time; zero once a reload removed it. */
  readonly capacity: number;
  /** How many Attempts hold a lease on the Worker. */
  readonly leased: number;
}

/**
 * The slots of each Worker that runs Attempts, in `usine.yaml` order, then of
 * each removed Worker until its last Attempt ends.
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

const freeWorker = (pool: SlotPool): Option.Option<WorkerName> =>
  Option.fromNullishOr([...pool].find(([, { capacity, leased }]) => leased < capacity)?.[0]);

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

const asAttemptFailure = (error: ExecutorError | ExecutorOperationError) =>
  error._tag === "WorkerCapabilityError"
    ? new AgentFailure({ message: error.message })
    : new InfraFailure({
        message:
          error._tag === "ExecutorOperationError"
            ? `Executor ${error.operation} failed: ${error.message}`
            : error.message,
        cause: error,
      });

// The operation error has no Worker field; reports must name the Worker.
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

/** exe.dev Workers write to GitHub through exe.dev's integration, as its bot (ADR 0011). */
const EXE_DEV_BOT_LOGIN = BotLogin.make("exe-dev-github-integration[bot]");
const decodeBotLogin = Schema.decodeUnknownOption(BotLogin);

/** How the executor a `stepExecutorLayer` drives takes Workers after startup. */
export interface StepExecutorOptions {
  /**
   * The executor runs only the Workers of `config`, as the SSH executor does,
   * which sets up each Worker's machine and Gateway forward when its layer
   * builds. A reload can then resize or remove those Workers and add one back
   * with the settings it started with, but refuses any other new Worker.
   */
  readonly startupWorkersOnly?: boolean;
}

/**
 * Schedules Attempts FIFO over the Workers and adapts the Executor to the
 * engine's StepExecutor port. It starts with the Workers in `config`, each
 * preflighted with `brains` and the current roster before the layer is ready,
 * and registers with the current instance, so a reload can resize, add, and
 * remove Workers. A reload preflights each Worker it adds or gives more slots
 * with every rostered brain, and each other Worker with the brains it adds,
 * before anything changes. A Worker with more running Attempts than slots
 * takes no new Attempt, and each extra slot retires when its Attempt ends; a
 * removed Worker leaves the scheduler when its last Attempt ends. Each Attempt
 * reads its `settings` (child budget, ceilings, parent effort) from the
 * current instance, and gets the bot login it writes to GitHub as: exe.dev's
 * integration bot on exe.dev Workers, the App's bot from `GitHubApp` on the
 * others, or none when the App's installation cannot be read. `WorkerStatus`
 * reads the slots and the last preflight of each Worker.
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

      const recordPreflightExit = Effect.fn("WorkerScheduler.recordPreflight")(function* (
        worker: WorkerName,
        roster: ReadonlyArray<BrainSpec>,
        exit: Exit.Exit<void, ExecutorError>,
      ) {
        const failure = Exit.findErrorOption(exit);
        // An interrupted or defective preflight says nothing about the Worker.
        if (Exit.isFailure(exit) && Option.isNone(failure)) return;
        const checkedAt = yield* DateTime.now;
        yield* Ref.update(preflights, (current) =>
          new Map(current).set(
            worker,
            recordPreflight(current.get(worker) ?? unchecked(worker), roster, checkedAt, failure),
          ),
        );
      });

      const preflightWorker = (worker: ConfigWorker, roster: ReadonlyArray<BrainSpec>) =>
        executor.preflight(worker.name, roster, worker.maxConcurrentAttempts).pipe(
          Effect.mapError(namingWorker(worker.name)),
          Effect.onExit((exit) => recordPreflightExit(worker.name, roster, exit)),
        );

      const unservedChange = (worker: ConfigWorker): Option.Option<RestartChange> => {
        if (worker.kind !== executor.kind) {
          return Option.some({
            block: "workers",
            field: `workers.${worker.name}.kind`,
            reason: `Worker ${worker.name} is ${worker.kind}, and the running Workers are ${executor.kind}`,
          });
        }
        const started = config.workers.some(
          (startup) =>
            startup.name === worker.name && changedWorkerSettings(startup, worker).length === 0,
        );
        return options.startupWorkersOnly === true && !started
          ? Option.some({
              block: "workers",
              field: `workers.${worker.name}`,
              reason: `Worker ${worker.name} is new, and the ${executor.kind} executor runs only the Workers usine up started with`,
            })
          : Option.none();
      };

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
        } else {
          yield* Effect.logInfo("Preflighting the Workers, slots, and brains the reload adds", {
            agents: agentNames,
            brains: newBrains.map(brainLabel),
            workers: [...wholeRoster],
          });
          yield* Effect.forEach(checks, ({ worker, brains }) => preflightWorker(worker, brains), {
            concurrency: "unbounded",
            discard: true,
          }).pipe(
            Effect.mapError((cause) => reloadPreflightFailed(agentNames, [...wholeRoster], cause)),
          );
        }
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
                ),
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

      // The transaction retries until a reservation and a free slot both exist, then takes both.
      const nextAssignment = Effect.tx(
        Effect.gen(function* () {
          const current = yield* TxRef.get(pool);
          const worker = freeWorker(current);
          if (Option.isNone(worker)) return yield* Effect.txRetry;
          const reservation = yield* TxPriorityQueue.take(pending);
          yield* TxRef.set(pool, withLeased(current, worker.value, 1));
          return { worker: worker.value, reservation };
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

      const reserve: StepExecutor["Service"]["reserve"] = Effect.fn("WorkerScheduler.reserve")(
        function* (submission) {
          const deferred = yield* Deferred.make<WorkerLease>();
          const state = yield* Ref.make<ReservationState>({ _tag: "Pending" });
          const reservation: Reservation = {
            deferred,
            eventTime: DateTime.toEpochMillis(submission.event.receivedAt),
            order: yield* Ref.getAndUpdate(nextOrder, (value) => value + 1),
            state,
          };
          yield* TxPriorityQueue.offer(pending, reservation);
          yield* Effect.logInfo("Run waits for a worker slot", {
            loop: submission.loop,
            itemKey: submission.itemKey,
            queued: yield* TxPriorityQueue.size(pending),
          });
          return yield* Deferred.await(deferred).pipe(
            Effect.onInterrupt(() =>
              Ref.modify(state, (current) =>
                current._tag === "Assigned"
                  ? [Option.some(current.lease), { _tag: "Canceled" } satisfies ReservationState]
                  : [Option.none<WorkerLease>(), { _tag: "Canceled" } satisfies ReservationState],
              ).pipe(
                Effect.flatMap(
                  Option.match({ onNone: () => Effect.void, onSome: (lease) => lease.release }),
                ),
              ),
            ),
          );
        },
      );

      // A login that cannot be read leaves harvesting to ask GitHub; it never fails the Attempt.
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
            .pipe(Effect.mapError(asAttemptFailure));
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
