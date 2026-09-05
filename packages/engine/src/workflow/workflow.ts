import { AgentFailure, AttemptFailure, InfraFailure } from "@usine/core/attempt/failure";
import { RunId } from "@usine/core/run";
import { StepResult } from "@usine/core/step/result";
import { Effect, Option, Result, Schema } from "effect";
import { DurableDeferred, Workflow, WorkflowEngine } from "effect/unstable/workflow";
import { StepExecutor } from "../step-executor.ts";
import { AttemptRecoveryFailed, RunStore } from "../store/store.ts";
import {
  EnginePersistenceError,
  RunNotFoundError,
  RunOperationRejectedError,
  type RunStoreError,
} from "../engine/error.ts";
import { Submission } from "../engine/submission.ts";

const WorkflowPayload = Schema.Struct({
  submission: Submission,
});
type WorkflowPayload = typeof WorkflowPayload.Type;

export const DurableRun = Workflow.make("@usine/engine/DurableRun", {
  payload: WorkflowPayload,
  success: StepResult,
  error: AttemptFailure,
  idempotencyKey: ({ submission }) => submission.event.dedupKey,
}).annotate(Workflow.SuspendOnFailure, true);

export const ApprovalGate = DurableDeferred.make("@usine/engine/ApprovalGate");

const asAttemptFailure = <A, R>(
  effect: Effect.Effect<A, RunStoreError, R>,
): Effect.Effect<A, AttemptFailure, R> =>
  Effect.catchTags(effect, {
    EnginePersistenceError: (error: EnginePersistenceError) =>
      new InfraFailure({
        message: `Engine persistence failed during ${error.operation}`,
        cause: error,
      }),
    RunNotFoundError: (error: RunNotFoundError) => Effect.die(error),
    RunOperationRejectedError: (error: RunOperationRejectedError) => Effect.die(error),
  });

const executionId = (submission: Submission) => DurableRun.executionId({ submission });

export const continueWithNewest: (
  store: RunStore["Service"],
  completedRunId: RunId,
) => Effect.Effect<void, RunStoreError, WorkflowEngine.WorkflowEngine> = Effect.fn(
  "DurableRun.continueWithNewest",
)(function* (store: RunStore["Service"], completedRunId: RunId) {
  const queued = yield* store.nextQueued(completedRunId);
  if (Option.isSome(queued)) {
    const nextExecutionId = yield* executionId(queued.value);
    const runId = RunId.make(nextExecutionId);
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
  const runId = RunId.make(executionId);
  const store = yield* RunStore;
  const executor = yield* StepExecutor;

  if (submission.approval === "required") {
    yield* store.parkForApproval(runId).pipe(asAttemptFailure);
    yield* DurableDeferred.await(ApprovalGate);
  }

  while (true) {
    // The wait for a worker slot stays interruptible: a cancel must be able
    // to reach a run parked in `reserve` (its scheduler releases or reoffers
    // the slot in its own onInterrupt). Only after the lease exists does the
    // release obligation begin.
    const lease = yield* executor.reserve(submission);
    const attempted = yield* Effect.gen(function* () {
      const started = yield* store.beginAttempt(runId, lease.worker).pipe(asAttemptFailure);
      if (started instanceof AttemptRecoveryFailed || started._tag === "RunClosed") {
        return started;
      }

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
              new InfraFailure({
                message: "The step executor crashed outside its typed failure channel",
                cause: defect,
              }),
          ),
          Effect.result,
        );
      return { _tag: "AttemptExecuted" as const, result, started };
    }).pipe(Effect.ensuring(lease.release));
    if (attempted._tag === "RunClosed") {
      // Canceled, superseded, or revoked while queued: release was the only
      // obligation; the closing operation already delivered the interrupt.
      yield* Effect.logInfo("Run closed while it waited for a worker", {
        runId,
        state: attempted.state,
      });
      yield* continueWithNewest(store, runId).pipe(asAttemptFailure);
      return yield* new AgentFailure({
        message: `The run closed (${attempted.state}) before an attempt started`,
      });
    }
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
  return RunId.make(yield* executionId(submission));
});
