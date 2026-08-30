import { AttemptFailure, Run, StepResult } from "@usine/core";
import { Effect, Option, Result, Schema } from "effect";
import { DurableDeferred, Workflow, WorkflowEngine } from "effect/unstable/workflow";
import { StepExecutor } from "./step-executor.ts";
import { AttemptRecoveryFailed, RunStore } from "./store/store.ts";
import {
  AttemptCancellationError,
  EnginePersistenceError,
  RunNotFoundError,
  RunOperationRejectedError,
  Submission,
  type RunEngineError,
} from "./model.ts";

const WorkflowPayload = Schema.Struct({
  submission: Submission,
});
type WorkflowPayload = typeof WorkflowPayload.Type;

export const DurableRun = Workflow.make("@usine/engine/DurableRun", {
  payload: WorkflowPayload,
  success: StepResult.StepResult,
  error: AttemptFailure.AttemptFailure,
  idempotencyKey: ({ submission }) => submission.event.dedupKey,
}).annotate(Workflow.SuspendOnFailure, true);

export const ApprovalGate = DurableDeferred.make("@usine/engine/ApprovalGate");

const asAttemptFailure = <A, R>(
  effect: Effect.Effect<A, RunEngineError, R>,
): Effect.Effect<A, AttemptFailure.AttemptFailure, R> =>
  Effect.catchTags(effect, {
    AttemptCancellationError: (error: AttemptCancellationError) =>
      new AttemptFailure.InfraFailure({
        message: `Attempt ${error.attemptId} cancellation failed`,
        cause: error,
      }),
    EnginePersistenceError: (error: EnginePersistenceError) =>
      new AttemptFailure.InfraFailure({
        message: `Engine persistence failed during ${error.operation}`,
        cause: error,
      }),
    RunNotFoundError: (error: RunNotFoundError) => Effect.die(error),
    RunOperationRejectedError: (error: RunOperationRejectedError) => Effect.die(error),
  });

const executionId = (submission: Submission) => DurableRun.executionId({ submission });

export const continueWithNewest: (
  store: RunStore["Service"],
  completedRunId: Run.RunId,
) => Effect.Effect<void, RunEngineError, WorkflowEngine.WorkflowEngine> = Effect.fn(
  "DurableRun.continueWithNewest",
)(function* (store: RunStore["Service"], completedRunId: Run.RunId) {
  const queued = yield* store.nextQueued(completedRunId);
  if (Option.isSome(queued)) {
    const nextExecutionId = yield* executionId(queued.value);
    const runId = Run.RunId.make(nextExecutionId);
    const claimed = yield* store.claimQueued(queued.value, runId);
    if (Option.isSome(claimed)) {
      yield* DurableRun.execute({ submission: claimed.value.submission }, { discard: true });
    }
  }
  yield* store.completeWorkflowCommand(completedRunId, "Continue");
});

const executeDurableRun = Effect.fn("DurableRun.execute")(function* (
  { submission }: WorkflowPayload,
  executionId: string,
) {
  const runId = Run.RunId.make(executionId);
  const store = yield* RunStore;
  const executor = yield* StepExecutor;

  if (submission.approval === "required") {
    yield* store.parkForApproval(runId).pipe(asAttemptFailure);
    yield* DurableDeferred.await(ApprovalGate);
  }

  while (true) {
    const attempted = yield* Effect.acquireUseRelease(
      executor.reserve(submission),
      (lease) =>
        Effect.gen(function* () {
          const started = yield* store.beginAttempt(runId, lease.worker).pipe(asAttemptFailure);
          if (started instanceof AttemptRecoveryFailed) return started;

          // Port ACL: the executor's contract is the typed AttemptFailure channel.
          // A defect escaping the adapter is infrastructure breakage around the
          // agent, so it is translated before reaching the durable workflow.
          const result = yield* executor
            .execute(started.execution, {
              append: (direction, envelope) =>
                store.appendTranscript(direction, envelope).pipe(asAttemptFailure),
            })
            .pipe(
              Effect.catchDefect(
                (defect) =>
                  new AttemptFailure.InfraFailure({
                    message: "The step executor crashed outside its typed failure channel",
                    cause: defect,
                  }),
              ),
              Effect.result,
            );
          return { _tag: "AttemptExecuted" as const, result, started };
        }),
      (lease) => lease.release,
    );
    if (attempted instanceof AttemptRecoveryFailed) {
      yield* continueWithNewest(store, runId).pipe(asAttemptFailure);
      return yield* attempted.failure;
    }

    const { result, started } = attempted;
    if (Result.isSuccess(result)) {
      yield* store.succeedAttempt(started.execution.attempt, result.success).pipe(asAttemptFailure);
      yield* continueWithNewest(store, runId).pipe(asAttemptFailure);
      return result.success;
    }

    const retry = yield* store
      .failAttempt(started.execution.attempt, result.failure)
      .pipe(asAttemptFailure);
    if (!retry) {
      yield* continueWithNewest(store, runId).pipe(asAttemptFailure);
      return yield* result.failure;
    }
  }
});

export const durableRunLayer = DurableRun.toLayer(executeDurableRun);

export const runIdFor = Effect.fn("DurableRun.runIdFor")(function* (submission: Submission) {
  return Run.RunId.make(yield* executionId(submission));
});
