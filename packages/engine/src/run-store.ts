import { Attempt, AttemptFailure, Event, Item, Loop, Run, RunState } from "@usine/core";
import { Cause, Context, DateTime, Effect, Exit, Layer, Option, Schema } from "effect";
import type { Workflow } from "effect/unstable/workflow";
import { RunDatabase } from "./database/database.ts";
import type { WorkflowCommand } from "./database/schema.ts";
import {
  Claimed,
  Ignored,
  Queued,
  RunOperationRejectedError,
  StepExecution,
  Submission,
} from "./model.ts";
import { persistence, submissionFromRow } from "./run-store-codec.ts";
import { queriesFor } from "./run-store-queries.ts";

const MAX_AUTO_ATTEMPTS = Attempt.AttemptNumber.make(3);

class StoredSubmission extends Schema.Class<StoredSubmission>(
  "@usine/engine/internal/StoredSubmission",
)({
  submission: Submission,
  runId: Run.RunId,
}) {}

class RecoverableRun extends Schema.Class<RecoverableRun>("@usine/engine/internal/RecoverableRun")({
  submission: Submission,
  runId: Run.RunId,
  state: RunState.RunState,
}) {}

class Claim extends Schema.Class<Claim>("@usine/engine/internal/Claim")({
  submission: Submission,
  result: Schema.Union([Claimed, Queued, Ignored]),
  supersededRun: Schema.Option(Run.RunId),
}) {}

class AttemptStarted extends Schema.TaggedClass<AttemptStarted>(
  "@usine/engine/internal/AttemptStarted",
)("AttemptStarted", {
  execution: StepExecution,
}) {}

class AttemptRecoveryFailed extends Schema.TaggedClass<AttemptRecoveryFailed>(
  "@usine/engine/internal/AttemptRecoveryFailed",
)("AttemptRecoveryFailed", {
  failure: AttemptFailure.InfraFailure,
}) {}

const makeRunStore = Effect.gen(function* () {
  const database = yield* RunDatabase;
  const queries = queriesFor(database);

  const claimedRun = (
    submission: Submission,
    runId: Run.RunId,
    supersededRun: Option.Option<Run.RunId> = Option.none(),
  ) =>
    new Claim({
      submission,
      result: new Claimed({ eventId: submission.event.id, runId }),
      supersededRun,
    });

  const openRun = Effect.fn("RunStore.openRun")(function* (
    tx: ReturnType<typeof queriesFor>,
    submission: Submission,
    runId: Run.RunId,
    supersededRun: Option.Option<Run.RunId> = Option.none(),
  ) {
    yield* tx.createRun(submission, submission.event.id, runId);
    return claimedRun(submission, runId, supersededRun);
  });

  const recordAndClaim = Effect.fn("RunStore.recordAndClaim")(function* (
    submission: Submission,
    requestedRunId: Run.RunId,
  ) {
    return yield* database.transaction((transaction) =>
      Effect.gen(function* () {
        const tx = queriesFor(transaction);
        const recorded = yield* tx.recordTriggerEvent(submission);
        const existing = yield* tx.runForEvent(recorded.event.id);
        if (existing[0] !== undefined) {
          return claimedRun(recorded, existing[0].runId);
        }

        const ignored = yield* tx.ignoredEvent(recorded.event.id);
        if (ignored[0] !== undefined) {
          return new Claim({
            submission: recorded,
            result: new Ignored({
              eventId: recorded.event.id,
              reason: ignored[0].reason,
            }),
            supersededRun: Option.none(),
          });
        }

        const blocking = yield* tx.blockingRun(recorded.loop, recorded.itemKey);
        const blockedBy = blocking[0];
        if (blockedBy === undefined) {
          return yield* openRun(tx, recorded, requestedRunId);
        }

        const blockedSnapshot = yield* tx.snapshot(blockedBy.runId);
        if (blockedSnapshot.run.state._tag === "Running") {
          return new Claim({
            submission: recorded,
            result: new Queued({ eventId: recorded.event.id }),
            supersededRun: Option.none(),
          });
        }
        if (
          blockedSnapshot.run.state._tag === "Pending" ||
          blockedSnapshot.run.state._tag === "Waiting"
        ) {
          yield* tx.updateState(
            blockedSnapshot.run.id,
            RunState.supersede(blockedSnapshot.run.state, recorded.event.id),
          );
          yield* tx.requestInterrupt(blockedSnapshot.run.id);
          return yield* openRun(tx, recorded, requestedRunId, Option.some(blockedSnapshot.run.id));
        }
        return yield* openRun(tx, recorded, requestedRunId);
      }),
    );
  });

  const parkForApproval = Effect.fn("RunStore.parkForApproval")(function* (runId: Run.RunId) {
    yield* database.transaction((transaction) =>
      Effect.gen(function* () {
        const tx = queriesFor(transaction);
        const current = yield* tx.snapshot(runId);
        if (current.run.state._tag === "Pending") {
          yield* tx.updateState(runId, RunState.awaitApproval(current.run.state));
        }
      }),
    );
  });

  const beginAttempt = Effect.fn("RunStore.beginAttempt")(function* (runId: Run.RunId) {
    return yield* database.transaction((transaction) =>
      Effect.gen(function* () {
        const tx = queriesFor(transaction);
        const current = yield* tx.snapshot(runId);
        let runState = current.run.state;
        const lastAttempt = current.attempts[current.attempts.length - 1];
        if (
          runState._tag === "Running" &&
          lastAttempt !== undefined &&
          Option.isNone(lastAttempt.outcome)
        ) {
          const failure = new AttemptFailure.InfraFailure({
            message: "The orchestrator stopped during the attempt",
            cause: new Error("attempt interrupted by orchestrator restart"),
          });
          yield* tx.closeAttempt(lastAttempt.id, new Attempt.Failed({ failure }));
          if (
            !Attempt.shouldAutoRetry({
              failure,
              number: lastAttempt.number,
              maxAutoAttempts: MAX_AUTO_ATTEMPTS,
            })
          ) {
            yield* tx.updateState(runId, RunState.fail(runState));
            yield* tx.requestWorkflowCommand(runId, "Continue");
            return new AttemptRecoveryFailed({ failure });
          }
        }

        if (runState._tag === "Pending" || runState._tag === "Waiting") {
          runState = RunState.start(runState);
          yield* tx.updateState(runId, runState);
        }
        if (runState._tag !== "Running") {
          return yield* new RunOperationRejectedError({
            runId,
            operation: "retry",
            state: runState._tag,
          });
        }

        const number = Attempt.AttemptNumber.make((lastAttempt?.number ?? 0) + 1);
        const attemptId = Attempt.AttemptId.make(`${runId}/${current.step.name}/${number}`);
        const startedAt = yield* DateTime.now;
        const attempt = new Attempt.Attempt({
          id: attemptId,
          runId,
          stepName: current.step.name,
          number,
          startedAt,
          outcome: Option.none(),
        });
        yield* tx.addAttempt(attempt);
        return new AttemptStarted({
          execution: new StepExecution({
            attempt,
            event: current.event,
            run: new Run.Run({
              id: current.run.id,
              eventId: current.run.eventId,
              loop: current.run.loop,
              state: runState,
              openedAt: current.run.openedAt,
            }),
            step: current.step,
          }),
        });
      }),
    );
  });

  const succeedAttempt = Effect.fn("RunStore.succeedAttempt")(function* (
    attempt: Attempt.Attempt,
    result: string,
  ) {
    yield* database.transaction((transaction) =>
      Effect.gen(function* () {
        const tx = queriesFor(transaction);
        const current = yield* tx.snapshot(attempt.runId);
        if (current.run.state._tag !== "Running") return;
        yield* tx.closeAttempt(attempt.id, new Attempt.Succeeded());
        yield* tx.updateStepResult(attempt.runId, attempt.stepName, result);
        yield* tx.updateState(attempt.runId, RunState.succeed(current.run.state));
        yield* tx.requestWorkflowCommand(attempt.runId, "Continue");
      }),
    );
  });

  const failAttempt = Effect.fn("RunStore.failAttempt")(function* (
    attempt: Attempt.Attempt,
    failure: AttemptFailure.AttemptFailure,
  ) {
    return yield* database.transaction((transaction) =>
      Effect.gen(function* () {
        const tx = queriesFor(transaction);
        const current = yield* tx.snapshot(attempt.runId);
        if (current.run.state._tag !== "Running") return false;
        yield* tx.closeAttempt(attempt.id, new Attempt.Failed({ failure }));
        const retry = Attempt.shouldAutoRetry({
          failure,
          number: attempt.number,
          maxAutoAttempts: MAX_AUTO_ATTEMPTS,
        });
        if (!retry) {
          yield* tx.updateState(attempt.runId, RunState.fail(current.run.state));
          yield* tx.requestWorkflowCommand(attempt.runId, "Continue");
        }
        return retry;
      }),
    );
  });

  const approve = Effect.fn("RunStore.approve")(function* (
    runId: Run.RunId,
    approval: Event.Event,
  ) {
    yield* database.transaction((transaction) =>
      Effect.gen(function* () {
        const tx = queriesFor(transaction);
        if (yield* tx.approvalExists(runId)) return;
        const current = yield* tx.snapshot(runId);
        if (current.run.state._tag !== "Waiting") {
          return yield* new RunOperationRejectedError({
            runId,
            operation: "approve",
            state: current.run.state._tag,
          });
        }
        yield* tx.recordApproval(runId, approval);
        yield* tx.requestWorkflowCommand(runId, "Approve");
      }),
    );
  });

  const retry = Effect.fn("RunStore.retry")(function* (runId: Run.RunId) {
    yield* database.transaction((transaction) =>
      Effect.gen(function* () {
        const tx = queriesFor(transaction);
        const current = yield* tx.snapshot(runId);
        if (current.run.state._tag === "Failed") {
          yield* tx.updateState(runId, RunState.retry(current.run.state));
          yield* tx.requestWorkflowCommand(runId, "Resume");
          return;
        }
        if (
          current.run.state._tag === "Running" &&
          (yield* tx.hasWorkflowCommand(runId, "Resume"))
        ) {
          return;
        }
        return yield* new RunOperationRejectedError({
          runId,
          operation: "retry",
          state: current.run.state._tag,
        });
      }),
    );
  });

  const cancel = Effect.fn("RunStore.cancel")(function* (runId: Run.RunId) {
    return yield* database.transaction((transaction) =>
      Effect.gen(function* () {
        const tx = queriesFor(transaction);
        const current = yield* tx.snapshot(runId);
        if (!RunState.isOpen(current.run.state)) return false;
        if (current.run.state._tag === "Running") {
          const attempt = current.attempts[current.attempts.length - 1];
          if (attempt !== undefined && Option.isNone(attempt.outcome)) {
            yield* tx.closeAttempt(attempt.id, new Attempt.Canceled());
          }
        }
        yield* tx.updateState(runId, RunState.cancelByOperator(current.run.state));
        yield* tx.requestInterrupt(runId);
        yield* tx.requestWorkflowCommand(runId, "Continue");
        return true;
      }),
    );
  });

  const revoke = Effect.fn("RunStore.revoke")(function* (
    loop: Loop.LoopName,
    itemKey: Item.ItemKey,
  ) {
    return yield* database.transaction((transaction) =>
      Effect.gen(function* () {
        const tx = queriesFor(transaction);
        const storedRuns = yield* tx.revokeUnstarted(loop, itemKey);
        for (const row of storedRuns) {
          const current = yield* tx.snapshot(row.runId);
          if (current.run.state._tag === "Pending" || current.run.state._tag === "Waiting") {
            yield* tx.updateState(row.runId, RunState.revoke(current.run.state));
            yield* tx.requestInterrupt(row.runId);
          }
        }
        return storedRuns.map((row) => row.runId);
      }),
    );
  });

  const claimQueued = Effect.fn("RunStore.claimQueued")(function* (
    submission: Submission,
    runId: Run.RunId,
  ) {
    return yield* database.transaction((transaction) =>
      Effect.gen(function* () {
        const tx = queriesFor(transaction);
        const existing = yield* tx.runForEvent(submission.event.id);
        if (existing[0] !== undefined) {
          return Option.some(new StoredSubmission({ submission, runId: existing[0].runId }));
        }
        if ((yield* tx.ignoredEvent(submission.event.id)).length > 0) {
          return Option.none<StoredSubmission>();
        }
        if ((yield* tx.blockingRun(submission.loop, submission.itemKey)).length > 0) {
          return Option.none<StoredSubmission>();
        }
        yield* tx.createRun(submission, submission.event.id, runId);
        return Option.some(new StoredSubmission({ submission, runId }));
      }),
    );
  });

  const recoverable = Effect.fn("RunStore.recoverable")(function* () {
    return (yield* queries.recoverable()).map(
      (row) =>
        new RecoverableRun({
          submission: submissionFromRow(row),
          runId: row.runId,
          state: row.state,
        }),
    );
  });

  const reconcileCompletion = Effect.fn("RunStore.reconcileCompletion")(function* (
    runId: Run.RunId,
    result: Workflow.Result<string, AttemptFailure.AttemptFailure>,
  ) {
    if (result._tag !== "Complete") return;
    yield* database.transaction((transaction) =>
      Effect.gen(function* () {
        const tx = queriesFor(transaction);
        const current = yield* tx.snapshot(runId);
        if (current.run.state._tag !== "Running") return;
        const attempt = current.attempts[current.attempts.length - 1];
        if (attempt === undefined || Option.isSome(attempt.outcome)) return;
        if (Exit.isSuccess(result.exit)) {
          yield* tx.closeAttempt(attempt.id, new Attempt.Succeeded());
          yield* tx.updateStepResult(attempt.runId, attempt.stepName, result.exit.value);
          yield* tx.updateState(runId, RunState.succeed(current.run.state));
          yield* tx.requestWorkflowCommand(runId, "Continue");
          return;
        }
        const failure = Cause.findErrorOption(result.exit.cause);
        if (Option.isNone(failure)) return;
        yield* tx.closeAttempt(attempt.id, new Attempt.Failed({ failure: failure.value }));
        yield* tx.updateState(runId, RunState.fail(current.run.state));
        yield* tx.requestWorkflowCommand(runId, "Continue");
      }),
    );
  });

  return {
    approve: (runId: Run.RunId, approval: Event.Event) =>
      approve(runId, approval).pipe(persistence("approve run")),
    beginAttempt: (runId: Run.RunId) => beginAttempt(runId).pipe(persistence("begin attempt")),
    cancel: (runId: Run.RunId) => cancel(runId).pipe(persistence("cancel run")),
    claimQueued: (submission: Submission, runId: Run.RunId) =>
      claimQueued(submission, runId).pipe(persistence("claim queued Event")),
    completeWorkflowCommand: (runId: Run.RunId, command: WorkflowCommand) =>
      queries
        .completeWorkflowCommand(runId, command)
        .pipe(persistence("complete workflow command")),
    failAttempt: (attempt: Attempt.Attempt, failure: AttemptFailure.AttemptFailure) =>
      failAttempt(attempt, failure).pipe(persistence("fail attempt")),
    nextQueued: (runId: Run.RunId) =>
      queries.nextQueued(runId).pipe(persistence("find queued Event")),
    parkForApproval: (runId: Run.RunId) =>
      parkForApproval(runId).pipe(persistence("park run for approval")),
    pendingWorkflowCommands: queries
      .pendingWorkflowCommands()
      .pipe(persistence("list pending workflow commands")),
    recordAndClaim: (submission: Submission, runId: Run.RunId) =>
      recordAndClaim(submission, runId).pipe(persistence("submit Event")),
    reconcileCompletion: (
      runId: Run.RunId,
      result: Workflow.Result<string, AttemptFailure.AttemptFailure>,
    ) => reconcileCompletion(runId, result).pipe(persistence("reconcile workflow completion")),
    recoverable: recoverable().pipe(persistence("list recoverable runs")),
    retry: (runId: Run.RunId) => retry(runId).pipe(persistence("retry run")),
    revoke: (loop: Loop.LoopName, itemKey: Item.ItemKey) =>
      revoke(loop, itemKey).pipe(persistence("revoke run")),
    snapshot: (runId: Run.RunId) => queries.snapshot(runId).pipe(persistence("read run")),
    succeedAttempt: (attempt: Attempt.Attempt, result: string) =>
      succeedAttempt(attempt, result).pipe(persistence("succeed attempt")),
  } as const;
});

export class RunStore extends Context.Service<RunStore, Effect.Success<typeof makeRunStore>>()(
  "@usine/engine/internal/RunStore",
) {
  static readonly layer = Layer.effect(RunStore, makeRunStore);
}

export { AttemptRecoveryFailed };
