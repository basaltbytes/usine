import type { UsineConfig, Worker as ConfigWorker } from "@usine/config/factory";
import { resolveParentEffort } from "@usine/core/agent";
import type { BrainSpec } from "@usine/core/agent/brain";
import { AgentFailure, InfraFailure } from "@usine/core/attempt/failure";
import { salvageRefFor } from "@usine/core/attempt/salvage";
import { WorkerName } from "@usine/core/worker";
import { CheckoutRequest, Executor, ExecutorError, ExecutorOperationError } from "@usine/executor";
import { StepExecutor, type WorkerLease } from "@usine/engine/step-executor";
import {
  Array as EffectArray,
  DateTime,
  Deferred,
  Effect,
  Layer,
  Option,
  Order,
  Queue,
  Ref,
  Schema,
  TxPriorityQueue,
} from "effect";
import { CurrentInstance } from "./current-instance/current-instance.ts";

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

const makeLease = Effect.fn("WorkerScheduler.makeLease")(function* (
  worker: WorkerName,
  available: Queue.Queue<WorkerName>,
) {
  const released = yield* Ref.make(false);
  return {
    worker,
    release: Ref.modify(released, (done) => [!done, true] as const).pipe(
      Effect.flatMap((first) => (first ? Queue.offer(available, worker) : Effect.void)),
      Effect.asVoid,
    ),
  } satisfies WorkerLease;
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

/**
 * Schedules Attempts FIFO over the configured Workers and adapts the Executor
 * to the engine's StepExecutor port. The Workers in `config` are fixed when
 * the layer builds. Each one preflights `brains` and the current roster
 * before the layer is ready, and the same preflight is registered with the
 * current instance, so a reload checks the brains it adds on every Worker.
 * Each Attempt reads its `settings` (child budget, ceilings, parent effort)
 * from the current instance.
 */
export const stepExecutorLayer = (
  config: UsineConfig,
  brains: ReadonlyArray<BrainSpec>,
): Layer.Layer<StepExecutor, ExecutorError | UnsupportedWorkerError, CurrentInstance | Executor> =>
  Layer.effect(
    StepExecutor,
    Effect.gen(function* () {
      const executor = yield* Executor;
      const instances = yield* CurrentInstance;
      const workers = yield* validateWorkers(executor.kind, config.workers);
      const preflight = Effect.fn("WorkerScheduler.preflight")(function* (
        roster: ReadonlyArray<BrainSpec>,
      ) {
        yield* Effect.forEach(
          workers,
          ({ name, maxConcurrentAttempts }) =>
            executor.preflight(name, roster, maxConcurrentAttempts).pipe(
              // The operation error has no Worker field; reports must name the Worker.
              Effect.mapError((error) =>
                error._tag === "ExecutorOperationError"
                  ? new ExecutorOperationError({
                      operation: error.operation,
                      message: `Worker ${name}: ${error.message}`,
                      cause: error.cause,
                    })
                  : error,
              ),
            ),
          { concurrency: "unbounded", discard: true },
        );
      });
      yield* instances.registerPreflight(preflight);
      // A reload can change the roster after the caller read `brains` and before the registration.
      const { agents } = yield* instances.get;
      yield* preflight(EffectArray.dedupe([...brains, ...agents.map(({ agent }) => agent.brain)]));

      const available = yield* Queue.make<WorkerName>();
      yield* Queue.offerAll(
        available,
        workers.flatMap(({ maxConcurrentAttempts, name }) =>
          Array.from({ length: maxConcurrentAttempts }, () => name),
        ),
      );
      const pending = yield* TxPriorityQueue.empty(reservationOrder);
      const nextOrder = yield* Ref.make(0);

      const dispatch = Effect.forever(
        Effect.gen(function* () {
          const worker = yield* Queue.take(available);
          const reservation = yield* TxPriorityQueue.take(pending);
          const lease = yield* makeLease(worker, available);
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

      const execute: StepExecutor["Service"]["execute"] = Effect.fn("WorkerScheduler.execute")(
        function* (execution, io) {
          yield* Effect.annotateCurrentSpan({
            attemptId: execution.attempt.id,
            runId: execution.run.id,
            worker: execution.attempt.worker,
            reattach: execution.reattach,
          });
          const { settings } = (yield* instances.get).config;
          const prepared = yield* executor
            .prepare(
              new CheckoutRequest({
                attemptId: execution.attempt.id,
                worker: execution.attempt.worker,
                repository: execution.repository,
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
              }),
            )
            .pipe(Effect.mapError(asAttemptFailure));
          return yield* prepared.launch(io);
        },
        Effect.scoped,
      );

      const interrupt: StepExecutor["Service"]["interrupt"] = (attemptId) =>
        executor.cancel(attemptId).pipe(Effect.mapError(asAttemptFailure));

      return StepExecutor.of({
        workers: workers.map(({ name }) => name),
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
    }),
  );
