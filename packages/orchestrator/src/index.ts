/** @usine/orchestrator — platform-free engine and worker composition. */

import type { Worker as ConfigWorker, UsineConfig } from "@usine/config";
import { AttemptFailure, Worker } from "@usine/core";
import {
  CheckoutRequest,
  Executor,
  ExecutorError,
  type ExecutorOperationError,
} from "@usine/executor";
import { StepExecutor, type WorkerLease } from "@usine/engine";
import {
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

export class UnsupportedWorkerError extends Schema.TaggedError<UnsupportedWorkerError>(
  "@usine/orchestrator/UnsupportedWorkerError",
)("UnsupportedWorkerError", {
  worker: Worker.Name,
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

const asInfrastructureFailure = (error: ExecutorError | ExecutorOperationError) =>
  new AttemptFailure.InfraFailure({
    message:
      error._tag === "ExecutorOperationError"
        ? `Executor ${error.operation} failed: ${error.message}`
        : error.message,
    cause: error,
  });

const makeLease = Effect.fn("WorkerScheduler.makeLease")(function* (
  worker: Worker.Name,
  available: Queue.Queue<Worker.Name>,
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

const validateLocalWorkers = (
  workers: ReadonlyArray<ConfigWorker>,
): Effect.Effect<ReadonlyArray<ConfigWorker>, UnsupportedWorkerError> => {
  const unsupported = workers.find((worker) => worker.kind !== "local");
  return unsupported === undefined
    ? Effect.succeed(workers)
    : new UnsupportedWorkerError({ worker: unsupported.name, kind: unsupported.kind });
};

/** Configured FIFO worker scheduler and Executor-to-engine adapter. */
export const stepExecutorLayer = (
  config: UsineConfig,
): Layer.Layer<StepExecutor, ExecutorError | UnsupportedWorkerError, Executor> =>
  Layer.effect(
    StepExecutor,
    Effect.gen(function* () {
      const executor = yield* Executor;
      const workers = yield* validateLocalWorkers(config.workers);
      yield* Effect.forEach(workers, ({ name }) => executor.preflight(name), {
        concurrency: "unbounded",
        discard: true,
      });

      const available = yield* Queue.make<Worker.Name>();
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
          });
          // `prepare` stays interruptible — a cancel must be able to stop a
          // hung clone or fetch; the adapter cleans its partial state on any
          // non-success exit.
          const prepared = yield* executor
            .prepare(
              new CheckoutRequest({
                attemptId: execution.attempt.id,
                worker: execution.attempt.worker,
                repository: execution.repository,
                revision: execution.revision,
                task: execution.task,
              }),
            )
            .pipe(Effect.mapError(asInfrastructureFailure));
          return yield* executor.launch(prepared, io).pipe(
            Effect.onInterrupt(() =>
              executor.cancel(execution.attempt.id).pipe(
                Effect.tapError((error) =>
                  Effect.logWarning("Cancel-on-interrupt failed", {
                    attemptId: execution.attempt.id,
                    message: error.message,
                  }),
                ),
                Effect.ignore,
              ),
            ),
            // ADR 0006: the worktree dies at attempt end regardless of outcome.
            // Cleanup never decides that outcome — a failed removal is logged,
            // not allowed to convert a finished agent session into a retryable
            // infra failure that would re-run non-idempotent work.
            Effect.ensuring(
              executor.cleanup(prepared).pipe(
                Effect.tapError((error) =>
                  Effect.logError("Attempt cleanup failed; the worktree may need manual removal", {
                    attemptId: execution.attempt.id,
                    worktree: prepared.worktree,
                    message: error.message,
                  }),
                ),
                Effect.ignore,
              ),
            ),
          );
        },
      );

      const interrupt: StepExecutor["Service"]["interrupt"] = (attemptId) =>
        executor.cancel(attemptId).pipe(Effect.mapError(asInfrastructureFailure));

      return StepExecutor.of({ execute, interrupt, reserve });
    }),
  );

export { gitHubCredentialLayer } from "./credentials.ts";
