import {
  AgentFailure,
  AttemptFailure,
  DefectFailure,
  InfraFailure,
} from "@usine/core/attempt/failure";
import { RunId } from "@usine/core/run";
import type { WorkerName } from "@usine/core/worker";
import { StepResult } from "@usine/core/step/result";
import { Effect, Option, Result, Schema } from "effect";
import { DurableDeferred, Workflow, WorkflowEngine } from "effect/unstable/workflow";
import { StepExecutor } from "../step-executor.ts";
import { TriggerCondition } from "../trigger-condition.ts";
import { AttemptAdmission } from "./admission.ts";
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

/**
 * Gives the newest queued Event its turn once the Run ahead of it closed. The
 * trigger is re-evaluated against the Item's current state first, because the
 * queued Event may describe state the closed Run itself changed.
 */
export const continueWithNewest: (
  store: RunStore["Service"],
  completedRunId: RunId,
) => Effect.Effect<void, RunStoreError, TriggerCondition | WorkflowEngine.WorkflowEngine> =
  Effect.fn("DurableRun.continueWithNewest")(function* (
    store: RunStore["Service"],
    completedRunId: RunId,
  ) {
    yield* Effect.annotateCurrentSpan({ runId: completedRunId });
    const queued = yield* store.nextQueued(completedRunId);
    if (Option.isSome(queued)) {
      const condition = yield* TriggerCondition;
      const submission = queued.value;
      const fields = {
        completedRunId,
        eventId: submission.event.id,
        loop: submission.loop,
        itemKey: submission.itemKey,
      };
      if (yield* condition.holds(submission)) {
        const runId = RunId.make(yield* executionId(submission));
        const claimed = yield* store.claimQueued(submission, runId);
        if (Option.isSome(claimed)) {
          yield* Effect.logInfo("Queued Event still matches its trigger; opening its Run", {
            ...fields,
            runId: claimed.value.runId,
          });
          yield* DurableRun.execute({ submission: claimed.value.submission }, { discard: true });
        }
      } else {
        const revoked = yield* store.revokeQueued(submission.loop, submission.itemKey);
        yield* Effect.logInfo("Queued Event no longer matches its trigger; revoked", {
          ...fields,
          revokedEvents: revoked,
        });
      }
    }
    yield* store.completeWorkflowCommand(completedRunId, "Continue");
  });

const executeAttempt = Effect.fn("DurableRun.attempt")(function* (
  runId: RunId,
  worker: WorkerName,
) {
  yield* Effect.annotateCurrentSpan({ runId, worker });
  const store = yield* RunStore;
  const executor = yield* StepExecutor;
  const started = yield* store.beginAttempt(runId, worker).pipe(asAttemptFailure);
  if (started instanceof AttemptRecoveryFailed || started._tag === "RunClosed") {
    return started;
  }

  // Durable workflows need a serializable terminal outcome. Preserve an
  // executor defect without turning a programming bug into an automatic retry.
  const result = yield* executor
    .execute(started.execution, {
      append: (direction, envelope) =>
        store.appendTranscript(direction, envelope).pipe(asAttemptFailure),
      salvage: (salvage) =>
        store.recordSalvage(started.execution.attempt.id, salvage).pipe(asAttemptFailure),
    })
    .pipe(
      Effect.catchDefect((defect) =>
        Effect.logError("Step executor defect; operator intervention required", { runId }).pipe(
          Effect.andThen(
            new DefectFailure({
              message: "The step executor crashed outside its typed failure channel",
              cause: defect,
            }),
          ),
        ),
      ),
      Effect.result,
    );
  const decision = yield* store
    .finishAttempt(started.execution.attempt, result)
    .pipe(asAttemptFailure);
  return { _tag: "AttemptExecuted" as const, result, decision };
});

const executeDurableRun = Effect.fn("DurableRun.execute")(function* (
  { submission }: WorkflowPayload,
  executionId: string,
) {
  const runId = RunId.make(executionId);
  const store = yield* RunStore;
  const executor = yield* StepExecutor;
  const admission = yield* AttemptAdmission;

  if (submission.approval === "required") {
    yield* store.parkForApproval(runId).pipe(asAttemptFailure);
    yield* DurableDeferred.await(ApprovalGate);
  }

  while (true) {
    // The wait for a worker slot stays interruptible so a cancel can reach a run
    // parked in `reserve`; the scheduler releases or reoffers the slot in its own
    // onInterrupt. The release obligation begins only once the lease exists.
    const attempted = yield* Effect.uninterruptibleMask((restore) =>
      restore(executor.reserve(submission)).pipe(
        Effect.flatMap((lease) =>
          restore(admission.withAttempt(runId, executeAttempt(runId, lease.worker))).pipe(
            Effect.ensuring(lease.release),
          ),
        ),
      ),
    );
    if (attempted._tag === "RunClosed") {
      // Canceled, superseded, or revoked while queued: release was the only
      // obligation, and the closing operation already delivered the interrupt.
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

    const { result, decision } = attempted;
    if (decision._tag !== "RetryAttempt") {
      yield* continueWithNewest(store, runId).pipe(asAttemptFailure);
      if (Result.isSuccess(result)) return result.success;
      return yield* result.failure;
    }
  }
});

export const durableRunLayer = DurableRun.toLayer(executeDurableRun);

export const runIdFor = Effect.fn("DurableRun.runIdFor")(function* (submission: Submission) {
  return RunId.make(yield* executionId(submission));
});
