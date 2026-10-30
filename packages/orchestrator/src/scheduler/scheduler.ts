import { ExpressionEngine } from "@usine/expression/expression-engine";
import { positionFor, positionFields } from "./position.ts";
import type { UsineConfig, Worker as ConfigWorker } from "@usine/config/factory";
import type { LoadedInstance } from "@usine/config/instance";
import { resolveParentEffort } from "@usine/core/agent";
import type { BrainSpec } from "@usine/core/agent/brain";
import { AgentFailure, InfraFailure } from "@usine/core/attempt/failure";
import type { AttemptId } from "@usine/core/attempt";
import { salvageRefFor } from "@usine/core/attempt/salvage";
import type { ItemKey } from "@usine/core/item";
import type { LoopName } from "@usine/core/loop";
import type { RunId } from "@usine/core/run";
import { ProvisionerTimings, WorkerName } from "@usine/core/worker";
import {
  CheckoutRequest,
  Executor,
  ExecutorError,
  fullPreflight,
  githubBotLogin,
  type MachineHold,
  type MachineUnavailableError,
  type WorkerCapabilityError,
  type WorkerMachines,
} from "@usine/executor";
import { StepExecutor, type WorkerLease } from "@usine/engine/step-executor";
import { GitHubApp, type GitHubAppError, isRefusal } from "@usine/github/github-app";
import {
  Array as EffectArray,
  Context,
  DateTime,
  Deferred,
  Duration,
  Effect,
  Exit,
  Layer,
  Match,
  Option,
  Ref,
  Result,
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
} from "../current-instance/changes.ts";
import {
  CurrentInstance,
  reloadPreflightFailed,
  restartRequired,
  type WorkerReload,
} from "../current-instance/current-instance.ts";
import { type LeaseCandidate, aheadCount, leaseOrder, passedCount } from "../lease-order.ts";
import { type ProvisioningPause, type QueuedRun, WorkerStatus } from "../worker-status.ts";

import { preflightFor } from "./preflight.ts";

/** A worker kind for which the scheduler has no configured executor. */
export class UnsupportedWorkerError extends Schema.TaggedError<UnsupportedWorkerError>(
  "@usine/orchestrator/UnsupportedWorkerError",
)("UnsupportedWorkerError", {
  /** The configured worker name. */
  worker: WorkerName,
  /** The configured worker kind that has no executor in this composition. */
  kind: Schema.String,
}) {}

type ReservationState =
  | { readonly _tag: "Pending" }
  | { readonly _tag: "Assigned"; readonly lease: WorkerLease }
  | { readonly _tag: "Canceled" };

interface Reservation extends LeaseCandidate {
  readonly runId: RunId;
  readonly loop: LoopName;
  readonly itemKey: ItemKey;
  readonly deferred: Deferred.Deferred<WorkerLease>;
  readonly state: Ref.Ref<ReservationState>;
}

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

/** Returns the Workers that take new Attempts: those `usine.yaml` declares with slots. */
const openWorkers = (pool: SlotPool): ReadonlyArray<WorkerName> =>
  [...pool].filter(([, { capacity }]) => capacity > 0).map(([worker]) => worker);

/** Returns the Runs of `queued`, which is in lease order, with the Runs ahead of each. */
const queuedRuns = (
  queued: ReadonlyArray<Reservation>,
  pool: SlotPool,
): ReadonlyArray<QueuedRun> => {
  const open = openWorkers(pool);
  return queued.map((reservation, index) => ({
    runId: reservation.runId,
    loop: reservation.loop,
    itemKey: reservation.itemKey,
    position: reservation.position,
    ahead: aheadCount(queued.slice(0, index), reservation, open),
  }));
};

const isFree = (pool: SlotPool, worker: WorkerName): boolean => {
  const slots = pool.get(worker);
  return slots !== undefined && slots.leased < slots.capacity;
};

/**
 * Returns the Worker with a free slot for `reservation`: its specified Worker, or else the first
 * free one that isn't `paused` from creating machines.
 */
const workerFor = (
  pool: SlotPool,
  paused: ReadonlyMap<WorkerName, WorkerPause>,
  reservation: Reservation,
): Option.Option<WorkerName> =>
  Option.match(reservation.worker, {
    onNone: () =>
      Option.fromNullishOr(
        [...pool.keys()].find(
          (worker) => isFree(pool, worker) && paused.get(worker)?.blocked !== true,
        ),
      ),
    onSome: (worker) => (isFree(pool, worker) ? Option.some(worker) : Option.none()),
  });

/** Returns the capped delay after consecutive machine creation failures. */
const pauseAfter = (failures: number, timings: ProvisionerTimings): Duration.Duration =>
  Duration.seconds(
    Math.min(
      timings.creationBackoffMin * 2 ** Math.min(failures - 1, 52),
      timings.creationBackoffMax,
    ),
  );

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

/** Returns the Attempt's failure for an unreadable bot account. A refusal isn't retried. */
const botAccountFailure = (error: GitHubAppError) => {
  const message = `Can't read the GitHub App's bot account, which authors the attempt's commits: ${error.message}`;
  return isRefusal(error)
    ? new AgentFailure({ message })
    : new InfraFailure({ message, cause: error });
};

/**
 * The Worker set of an executor that connects only to the Workers it was given, such as the SSH
 * executor.
 */
export interface ExecutorWorkers {
  /**
   * Adds `worker` to the executor before each preflight. Repeated additions are idempotent.
   * A failure disables the worker at startup or refuses a reload.
   */
  readonly add: (worker: ConfigWorker) => Effect.Effect<void, ExecutorError>;
  /**
   * Removes `worker` once no Attempt runs on it: a Worker removed by a reload, or one added by a
   * reload whose preparation or persistence failed.
   */
  readonly remove: (worker: WorkerName) => Effect.Effect<void>;
}

/**
 * Optional worker lifecycle, machine provisioning, and cleanup operations for a scheduler adapter.
 */
export interface StepExecutorOptions {
  /**
   * The executor's worker set, initialized during preflight and updated on each reload. If omitted,
   * the executor runs any worker of its kind by name, like the local executor.
   */
  readonly workers?: ExecutorWorkers;
  /**
   * The machines of provisioned Workers, which create one machine per Attempt (#550). If omitted,
   * no Worker is provisioned.
   */
  readonly machines?: WorkerMachines["Service"];
  /**
   * Removes what discarded Attempts left on a Worker outside their checkouts; see
   * `StepExecutor.discard`. If omitted, removes nothing.
   */
  readonly discard?: StepExecutor["Service"]["discard"];
}

/** The machine a lease holds, which its release deletes. */
type LeaseMachine = Ref.Ref<Option.Option<MachineHold>>;

type WorkerPause = Omit<ProvisioningPause, "waitingRuns">;

interface RunMachine {
  readonly worker: WorkerName;
  readonly machine: LeaseMachine;
}

/** The Worker set of an executor that runs any Worker of its kind by name. */
const anyWorker: ExecutorWorkers = { add: () => Effect.void, remove: () => Effect.void };

/**
 * Schedules Attempts over the Workers in `leaseOrder` and adapts the Executor to the engine's
 * `StepExecutor` port. A removed Worker stays until its last Attempt ends.
 */
export const stepExecutorLayer = (
  config: UsineConfig,
  brains: ReadonlyArray<BrainSpec>,
  options: StepExecutorOptions = {},
): Layer.Layer<
  StepExecutor | WorkerStatus,
  ExecutorError | UnsupportedWorkerError,
  CurrentInstance | Executor | GitHubApp | ExpressionEngine
> =>
  Layer.effectContext(
    Effect.gen(function* () {
      const schedulerScope = yield* Effect.scope;
      const executor = yield* Executor;
      const instances = yield* CurrentInstance;
      const positionOf = positionFor(instances, yield* ExpressionEngine);
      const app = yield* GitHubApp;
      const workers = yield* validateWorkers(executor.kind, config.workers);
      const pool = yield* TxRef.make(slotPoolOf(workers, new Map()));
      const pending = yield* TxPriorityQueue.empty<Reservation>(leaseOrder);
      const nextOrder = yield* Ref.make(0);
      const executorWorkers = options.workers ?? anyWorker;
      const preflight = yield* preflightFor(executor, executorWorkers.add);
      const availablePool = Effect.all([TxRef.get(pool), preflight.blocked]).pipe(
        Effect.map(
          ([current, blocked]): SlotPool =>
            new Map(
              [...current].map(([name, slots]) => [
                name,
                blocked.has(name) ? { ...slots, capacity: 0 } : slots,
              ]),
            ),
        ),
      );
      // Every change to the executor's Workers takes this permit, so a removal never undoes an
      // addition.
      const membership = yield* Semaphore.make(1);
      const adding = yield* Ref.make<ReadonlySet<WorkerName>>(new Set());
      const machines = options.machines;
      const paused = yield* TxRef.make<ReadonlyMap<WorkerName, WorkerPause>>(new Map());
      // The machine of each Run's lease, which `execute` gives to the Run's Attempt.
      const runMachines = yield* Ref.make<ReadonlyMap<RunId, RunMachine>>(new Map());
      const provisions = (worker: WorkerName) =>
        machines === undefined ? Effect.succeed(false) : machines.provisions(worker);

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
              reason: `worker "${worker.name}" has kind ${worker.kind}, and the running workers have kind ${executor.kind}`,
            });

      const applyWorkers = Effect.fn("WorkerScheduler.applyWorkers")(function* (
        change: WorkersChange,
        declared: ReadonlyArray<ConfigWorker>,
        roster: ReadonlyArray<BrainSpec>,
        checked: ReadonlySet<WorkerName>,
      ) {
        const before = yield* TxRef.modify(pool, (current) => [
          current,
          slotPoolOf(declared, current),
        ]);
        yield* preflight.accept(declared, roster, checked);
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

      const prepareReload: WorkerReload = Effect.fn("WorkerScheduler.prepareReload")(
        function* (running: LoadedInstance, loaded: LoadedInstance) {
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
            ...change.resized.map(({ worker }) => worker.name),
          ]);
          const blocked = yield* preflight.blocked;
          const checks = loaded.config.workers.flatMap((worker) =>
            wholeRoster.has(worker.name)
              ? [{ worker, brains: roster }]
              : newBrains.length > 0
                ? [{ worker, brains: blocked.has(worker.name) ? roster : newBrains }]
                : [],
          );
          const apply = preflight.exclusive.withPermit(
            applyWorkers(
              change,
              loaded.config.workers,
              roster,
              new Set(checks.map(({ worker }) => worker.name)),
            ),
          );
          yield* Effect.annotateCurrentSpan({ agents: agentNames, workers: [...wholeRoster] });
          if (checks.length === 0) {
            yield* Effect.logDebug(
              "The reload adds no worker or brain and changes no slots, so it runs no worker preflight",
            );
            return apply;
          }
          const added = new Set(change.added.map(({ name }) => name));
          yield* Effect.acquireRelease(
            membership.withPermit(Ref.update(adding, (current) => new Set([...current, ...added]))),
            (_, exit) =>
              Exit.isFailure(exit)
                ? Effect.logInfo("Releasing workers prepared for a failed configuration change", {
                    workers: [...added],
                  }).pipe(Effect.andThen(settleAdded(added, [...added])))
                : Effect.void,
          );
          yield* Effect.logInfo("Preflighting the Workers, slots, and brains the reload adds", {
            agents: agentNames,
            brains: newBrains.map(brainLabel),
            workers: [...wholeRoster],
          });
          // Add the Worker to the executor first, so its preflight can connect to its machine.
          yield* Effect.forEach(checks, ({ worker, brains }) => preflight.check(worker, brains), {
            concurrency: "unbounded",
            discard: true,
          }).pipe(
            Effect.mapError((cause) => reloadPreflightFailed(agentNames, [...wholeRoster], cause)),
          );
          return apply;
        },
        (effect) => preflight.exclusive.withPermit(effect),
      );

      yield* instances.registerWorkers(prepareReload);
      // A reload can change the roster after the caller read `brains` and before the registration.
      const { agents } = yield* instances.get;
      const startupRoster = EffectArray.dedupe([
        ...brains,
        ...agents.map(({ agent }) => agent.brain),
      ]);
      yield* preflight.exclusive.withPermit(preflight.start(workers, startupRoster));

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

      /** Deletes the machine that `machine` holds, if any, before the slot frees. */
      const releaseMachine = (worker: WorkerName, machine: LeaseMachine) =>
        Ref.getAndSet(machine, Option.none()).pipe(
          Effect.flatMap((hold) =>
            Option.match(hold, {
              onNone: () => Effect.void,
              onSome: (held) =>
                machines === undefined
                  ? Effect.void
                  : Effect.logDebug("Deleting the machine of the released slot", {
                      worker,
                      hold: held,
                    }).pipe(Effect.andThen(machines.release(held))),
            }),
          ),
        );

      const makeLease = Effect.fn("WorkerScheduler.makeLease")(function* (
        worker: WorkerName,
        hold: Option.Option<MachineHold> = Option.none(),
        runId: Option.Option<RunId> = Option.none(),
      ) {
        const released = yield* Ref.make(false);
        const machine: LeaseMachine = yield* Ref.make(hold);
        if (Option.isSome(runId))
          yield* Ref.update(runMachines, (current) =>
            new Map(current).set(runId.value, { worker, machine }),
          );
        const forget = Option.match(runId, {
          onNone: () => Effect.void,
          onSome: (run) =>
            Ref.update(runMachines, (current) => {
              if (current.get(run)?.machine !== machine) return current;
              const next = new Map(current);
              next.delete(run);
              return next;
            }),
        });
        return {
          worker,
          release: Ref.modify(released, (done) => [!done, true] as const).pipe(
            Effect.flatMap((first) =>
              first
                ? forget.pipe(
                    Effect.andThen(releaseMachine(worker, machine)),
                    Effect.andThen(releaseSlot(worker)),
                  )
                : Effect.void,
            ),
          ),
        } satisfies WorkerLease;
      });

      // Retries until a free slot can take a waiting reservation, then takes both. A reservation
      // whose Worker has no free slot doesn't block the ones behind it.
      const nextAssignment = Effect.tx(
        Effect.gen(function* () {
          const current = yield* TxRef.get(pool);
          const available = yield* availablePool;
          const pauses = yield* TxRef.get(paused);
          const waiting = yield* TxPriorityQueue.toArray(pending);
          const next = EffectArray.findFirst(waiting, (reservation) =>
            Option.map(workerFor(available, pauses, reservation), (worker) => ({
              worker,
              reservation,
            })),
          );
          if (Option.isNone(next)) return yield* Effect.txRetry;
          const { worker, reservation } = next.value;
          yield* TxPriorityQueue.removeIf(pending, (queued) => queued === reservation);
          yield* TxRef.set(pool, withLeased(current, worker, 1));
          return { worker, reservation, passed: passedCount(waiting, reservation) };
        }),
      );

      /** Pauses machine creation on `worker` after `failure`, and resumes it when the pause ends. */
      const pauseWorker = Effect.fn("WorkerScheduler.pauseWorker")(function* (
        worker: WorkerName,
        failure: MachineUnavailableError | WorkerCapabilityError,
      ) {
        const { config } = yield* instances.get;
        const configured = config.workers.find(({ name }) => name === worker);
        const timings =
          configured?.kind === "ssh" && Option.isSome(configured.provisioner)
            ? configured.provisioner.value.timings
            : new ProvisionerTimings({});
        yield* Effect.annotateCurrentSpan({ worker });
        const failedAt = yield* DateTime.now;
        const pause = yield* Effect.tx(
          TxRef.modify(paused, (current) => {
            const failures = (current.get(worker)?.failures ?? 0) + 1;
            const delay = pauseAfter(failures, timings);
            const next: WorkerPause = {
              quota:
                failure._tag === "MachineUnavailableError" && failure.reason === "quota"
                  ? Option.some(failure.message)
                  : (current.get(worker)?.quota ?? Option.none()),
              worker,
              reason: failure._tag === "MachineUnavailableError" ? failure.reason : "check",
              message: failure.message,
              failures,
              failedAt,
              retryAt: DateTime.addDuration(failedAt, delay),
              blocked: true,
            };
            return [next, new Map(current).set(worker, next)] as const;
          }),
        );
        yield* Effect.logWarning(
          "A provisioned Worker could not create a machine; its Attempts wait and it tries again after a pause",
          {
            worker,
            reason: pause.reason,
            message: pause.message,
            quota: pause.quota,
            failures: pause.failures,
            retryAt: DateTime.formatIso(pause.retryAt),
          },
        );
        yield* Effect.sleep(DateTime.distance(failedAt, pause.retryAt)).pipe(
          Effect.andThen(
            Effect.tx(
              TxRef.update(paused, (current) => {
                const latest = current.get(worker);
                return latest === undefined || latest.failures !== pause.failures
                  ? current
                  : new Map(current).set(worker, { ...latest, blocked: false });
              }),
            ),
          ),
          Effect.andThen(
            Effect.logInfo("A provisioned Worker's pause ended; it creates machines again", {
              worker,
              failures: pause.failures,
            }),
          ),
          Effect.forkIn(schedulerScope),
        );
      }, Effect.uninterruptible);

      const dispatch = Effect.forever(
        Effect.gen(function* () {
          const { worker, reservation, passed } = yield* nextAssignment;
          const lease = yield* makeLease(worker, Option.none(), Option.some(reservation.runId));
          const assign = yield* Ref.modify(reservation.state, (state) =>
            state._tag === "Pending"
              ? [true, { _tag: "Assigned", lease } satisfies ReservationState]
              : [false, state],
          );
          const fields = {
            runId: reservation.runId,
            loop: reservation.loop,
            itemKey: reservation.itemKey,
            worker,
          };
          if (assign) {
            yield* Effect.logInfo("Worker slot leased in lease order", {
              ...fields,
              ...positionFields(reservation.position),
              passed,
            });
            yield* Deferred.succeed(reservation.deferred, lease);
          } else {
            yield* Effect.logDebug(
              "The Run stopped waiting before its lease; the Worker slot is free again",
              fields,
            );
            yield* lease.release;
          }
        }),
      );
      yield* Effect.forkScoped(dispatch);

      const occupy: StepExecutor["Service"]["occupy"] = Effect.fn("WorkerScheduler.occupy")(
        function* (worker, attemptId) {
          yield* Effect.annotateCurrentSpan({ worker, attemptId });
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
          const hold =
            machines !== undefined && (yield* provisions(worker))
              ? yield* machines.adopt(worker, attemptId)
              : Option.none<MachineHold>();
          return yield* makeLease(worker, hold);
        },
      );

      const reserve: StepExecutor["Service"]["reserve"] = Effect.fn("WorkerScheduler.reserve")(
        function* (runId, submission, worker) {
          const run = { runId, loop: submission.loop, itemKey: submission.itemKey };
          yield* Effect.annotateCurrentSpan(run);
          if (Option.isSome(worker)) yield* Effect.annotateCurrentSpan({ worker: worker.value });
          const deferred = yield* Deferred.make<WorkerLease>();
          const state = yield* Ref.make<ReservationState>({ _tag: "Pending" });
          const reservation: Reservation = {
            ...run,
            deferred,
            worker,
            position: yield* positionOf(runId, submission),
            eventTime: DateTime.toEpochMillis(submission.event.receivedAt),
            order: yield* Ref.getAndUpdate(nextOrder, (value) => value + 1),
            state,
          };
          const [queue, current] = yield* Effect.tx(
            TxPriorityQueue.offer(pending, reservation).pipe(
              Effect.andThen(Effect.all([TxPriorityQueue.toArray(pending), availablePool])),
            ),
          );
          const fields = {
            ...run,
            ...positionFields(reservation.position),
            queued: queue.length,
            ahead: aheadCount(
              queue.slice(0, queue.indexOf(reservation)),
              reservation,
              openWorkers(current),
            ),
          };
          if (Option.isNone(worker)) yield* Effect.logInfo("Run waits for a worker slot", fields);
          else if ((current.get(worker.value)?.capacity ?? 0) > 0)
            yield* Effect.logInfo(
              "Run waits for a slot on the Worker its reattached Attempt runs on",
              { ...fields, worker: worker.value },
            );
          else
            yield* Effect.logWarning(
              "Run waits for a slot on the Worker its reattached Attempt runs on, which is unavailable or no longer declared; it waits until preflight passes, a reload declares that Worker again, or the Run is canceled",
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

      /**
       * Creates a machine for the persisted Attempt, or adopts its machine on reattachment.
       * Creation failures retry within this Attempt without consuming an engine retry.
       */
      const machineForAttempt = Effect.fn("WorkerScheduler.machineForAttempt")(function* (
        execution: Parameters<StepExecutor["Service"]["execute"]>[0],
      ) {
        const worker = execution.attempt.worker;
        if (machines === undefined || !(yield* provisions(worker))) return;
        const attemptId = execution.attempt.id;
        const fields = { runId: execution.run.id, attemptId, worker };
        yield* Effect.annotateCurrentSpan(fields);
        const machine = (yield* Ref.get(runMachines)).get(execution.run.id)?.machine;
        if (execution.reattach) {
          const adopted = yield* machines.adopt(worker, attemptId);
          if (machine !== undefined && Option.isNone(yield* Ref.get(machine)))
            yield* Ref.set(machine, adopted);
          return yield* Effect.logDebug("The reattached Attempt keeps its machine", {
            ...fields,
            found: Option.isSome(adopted),
          });
        }
        if (machine === undefined)
          return yield* Effect.die(new Error("no lease for the persisted Attempt"));
        const { agents } = yield* instances.get;
        const roster = EffectArray.dedupe(agents.map(({ agent }) => agent.brain));
        while (true) {
          yield* Effect.tx(
            Effect.gen(function* () {
              if ((yield* TxRef.get(paused)).get(worker)?.blocked === true) yield* Effect.txRetry;
            }),
          );
          const created = yield* Effect.uninterruptibleMask((restore) =>
            restore(machines.create(worker, execution.run.id, attemptId, roster)).pipe(
              Effect.tap((grant) => Ref.set(machine, Option.some(grant.hold))),
              Effect.result,
            ),
          );
          if (Result.isFailure(created)) {
            if (created.failure._tag === "WorkerCapabilityError")
              yield* preflight.record(worker, roster, Exit.fail(created.failure));
            yield* pauseWorker(worker, created.failure);
            yield* Effect.logInfo("Attempt waits to retry machine creation", fields);
            continue;
          }
          yield* TxRef.update(paused, (current) => {
            const next = new Map(current);
            next.delete(worker);
            return next;
          });
          if (Option.isSome(created.success.checked)) {
            const { brains, containerLimits } = created.success.checked.value;
            yield* preflight.record(
              worker,
              brains,
              Exit.succeed({ ...fullPreflight, containerLimits }),
            );
          }
          yield* Effect.logInfo("Machine ready for the persisted Attempt", {
            ...fields,
            machine: created.success.id,
            provider: created.success.provider,
          });
          return;
        }
      });

      // Every Worker kind commits as the App's bot account; only exe.dev writes to GitHub through
      // another bot.
      const writerFor = Effect.fn("WorkerScheduler.writer")(
        function* (attemptId: AttemptId) {
          yield* Effect.annotateCurrentSpan({ attemptId });
          const commitAuthor = yield* app.botAccount();
          const botLogin = githubBotLogin(executor.kind, commitAuthor.login);
          return { commitAuthor, botLogin };
        },
        (effect, attemptId) =>
          effect.pipe(
            Effect.tapError((error) =>
              Effect.logWarning(
                isRefusal(error)
                  ? "Could not read the App's bot account, which authors the Attempt's commits; the Attempt fails without an automatic retry"
                  : "Could not read the App's bot account, which authors the Attempt's commits; the Attempt fails with an infrastructure failure, which is retried",
                { attemptId, errorTag: error._tag, message: error.message },
              ),
            ),
            Effect.mapError(botAccountFailure),
          ),
      );

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
          const { commitAuthor, botLogin } = yield* writerFor(execution.attempt.id);
          yield* machineForAttempt(execution);
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
                botLogin: Option.some(botLogin),
                commitAuthor,
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

      const interrupt: StepExecutor["Service"]["interrupt"] = (attemptId, reason) =>
        executor.cancel(attemptId, reason).pipe(Effect.mapError(asAttemptFailure));

      const status = WorkerStatus.of({
        slots: availablePool.pipe(
          Effect.map((current) =>
            [...current].map(([worker, { capacity, leased }]) => ({ worker, capacity, leased })),
          ),
        ),
        queue: Effect.tx(Effect.all([TxPriorityQueue.toArray(pending), availablePool])).pipe(
          Effect.map(([queued, current]) => queuedRuns(queued, current)),
        ),
        preflights: preflight.records,
        unavailable: preflight.unavailable,
        machines: machines === undefined ? Effect.succeed([]) : machines.machines,
        provisioning: Effect.gen(function* () {
          const waiting = yield* Effect.forEach(
            [...(yield* Ref.get(runMachines))],
            ([runId, { worker, machine }]) =>
              Ref.get(machine).pipe(
                Effect.map((hold) => (Option.isNone(hold) ? [{ runId, worker }] : [])),
              ),
          );
          return [...(yield* TxRef.get(paused)).values()].map((pause): ProvisioningPause => ({
            ...pause,
            waitingRuns: waiting
              .flat()
              .filter(({ worker }) => worker === pause.worker)
              .map(({ runId }) => runId),
          }));
        }),
      });

      const stepExecutor = StepExecutor.of({
        workers: TxRef.get(pool).pipe(Effect.map((current) => [...current.keys()])),
        execute,
        interrupt,
        isLive: executor.isLive,
        outcome: executor.outcome,
        reserve,
        occupy,
        sweep: Effect.andThen(
          executor.sweep,
          machines === undefined ? Effect.void : machines.sweep,
        ),
        discard: options.discard ?? (() => Effect.void),
        intervene: executor.intervene,
        recover: (attempt, record) =>
          executor
            .recover(attempt, record, app.botAccount().pipe(Effect.mapError(botAccountFailure)))
            .pipe(
              Effect.catchIf(Schema.is(ExecutorError), (error) =>
                Effect.fail(asAttemptFailure(error)),
              ),
            ),
      });
      return Context.make(StepExecutor, stepExecutor).pipe(Context.add(WorkerStatus, status));
    }),
  );
