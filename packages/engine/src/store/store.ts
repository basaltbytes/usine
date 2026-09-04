import { Attempt, AttemptNumber, shouldAutoRetry } from "@usine/core/attempt";
import * as AttemptChannel from "@usine/core/attempt/channel";
import { AttemptFailure, InfraFailure } from "@usine/core/attempt/failure";
import { AttemptCanceled, AttemptFailed, AttemptSucceeded } from "@usine/core/attempt/outcome";
import { Event } from "@usine/core/event";
import { AttemptId, ItemKey, LoopName, RunId, WorkerName } from "@usine/core/ids";
import { Run } from "@usine/core/run";
import * as RunState from "@usine/core/run/state";
import { StepResult } from "@usine/core/step/result";
import { Cause, Context, DateTime, Effect, Exit, Layer, Option, Schema } from "effect";
import type { Workflow } from "effect/unstable/workflow";
import { RunDatabase } from "../database/database.ts";
import {
  Claimed,
  Ignored,
  Queued,
  RunOperationRejectedError,
  RunSnapshot,
  StepExecution,
  Submission,
  TranscriptEntry,
  TranscriptQuery,
  type RunStoreError,
  type WorkflowCommand,
} from "../model.ts";
import { persistence, submissionFromRow, type WorkflowCommandRow } from "./codec.ts";
import { queriesFor } from "./queries.ts";

const MAX_AUTO_ATTEMPTS = AttemptNumber.make(3);

export class StoredSubmission extends Schema.Class<StoredSubmission>(
  "@usine/engine/internal/StoredSubmission",
)({
  submission: Submission,
  runId: RunId,
}) {}

export class RecoverableRun extends Schema.Class<RecoverableRun>(
  "@usine/engine/internal/RecoverableRun",
)({
  submission: Submission,
  runId: RunId,
  state: RunState.RunState,
}) {}

export class Claim extends Schema.Class<Claim>("@usine/engine/internal/Claim")({
  submission: Submission,
  result: Schema.Union([Claimed, Queued, Ignored]),
  supersededRun: Schema.Option(RunId),
}) {}

export class AttemptStarted extends Schema.TaggedClass<AttemptStarted>(
  "@usine/engine/internal/AttemptStarted",
)("AttemptStarted", {
  execution: StepExecution,
}) {}

export class AttemptRecoveryFailed extends Schema.TaggedClass<AttemptRecoveryFailed>(
  "@usine/engine/internal/AttemptRecoveryFailed",
)("AttemptRecoveryFailed", {
  failure: InfraFailure,
}) {}

/**
 * The Run closed (canceled, superseded, or revoked) while it waited for a
 * worker slot — a routine outcome once capacity queues exist, never an error.
 */
export class RunClosed extends Schema.TaggedClass<RunClosed>("@usine/engine/internal/RunClosed")(
  "RunClosed",
  {
    state: Schema.String,
  },
) {}

/** What `RunStore.cancel` did, decided inside the closing transaction. */
export type CancelOutcome =
  | { readonly _tag: "AlreadyClosed" }
  | { readonly _tag: "Canceled"; readonly openAttempt: Option.Option<AttemptId> };

const makeRunStore = Effect.gen(function* () {
  const database = yield* RunDatabase;
  const queries = queriesFor(database);

  const claimedRun = (
    submission: Submission,
    runId: RunId,
    supersededRun: Option.Option<RunId> = Option.none(),
  ) =>
    new Claim({
      submission,
      result: new Claimed({ eventId: submission.event.id, runId }),
      supersededRun,
    });

  const openRun = Effect.fn("RunStore.openRun")(function* (
    tx: ReturnType<typeof queriesFor>,
    submission: Submission,
    runId: RunId,
    supersededRun: Option.Option<RunId> = Option.none(),
  ) {
    yield* tx.createRun(submission, submission.event.id, runId);
    return claimedRun(submission, runId, supersededRun);
  });

  const recordAndClaim = Effect.fn("RunStore.recordAndClaim")(function* (
    submission: Submission,
    requestedRunId: RunId,
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
        if (RunState.isUnstarted(blockedSnapshot.run.state)) {
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
  }, persistence("submit Event"));

  const parkForApproval = Effect.fn("RunStore.parkForApproval")(function* (runId: RunId) {
    yield* database.transaction((transaction) =>
      Effect.gen(function* () {
        const tx = queriesFor(transaction);
        const current = yield* tx.snapshot(runId);
        if (current.run.state._tag === "Pending") {
          yield* tx.updateState(runId, RunState.awaitApproval(current.run.state));
        }
      }),
    );
  }, persistence("park run for approval"));

  const beginAttempt = Effect.fn("RunStore.beginAttempt")(function* (
    runId: RunId,
    worker: WorkerName,
  ) {
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
          const failure = new InfraFailure({
            message: "The orchestrator stopped during the attempt",
            cause: new Error("attempt interrupted by orchestrator restart"),
          });
          yield* tx.closeAttempt(lastAttempt.id, new AttemptFailed({ failure }));
          if (
            !shouldAutoRetry({
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

        if (RunState.isStartable(runState)) {
          runState = RunState.start(runState);
          yield* tx.updateState(runId, runState);
        }
        if (runState._tag !== "Running") {
          // Cancel, supersede, and revoke can all land while the run waits
          // for a worker slot; the caller releases the slot and moves on.
          return new RunClosed({ state: runState._tag });
        }

        const number = AttemptNumber.make((lastAttempt?.number ?? 0) + 1);
        const attemptId = AttemptId.make(`${runId}/${current.step.name}/${number}`);
        const startedAt = yield* DateTime.now;
        const attempt = new Attempt({
          id: attemptId,
          runId,
          stepName: current.step.name,
          worker,
          number,
          brain: current.agent.brain,
          parentModel: current.parentModel,
          startedAt,
          outcome: Option.none(),
        });
        yield* tx.addAttempt(attempt);
        return new AttemptStarted({
          execution: new StepExecution({
            attempt,
            event: current.event,
            run: new Run({
              id: current.run.id,
              eventId: current.run.eventId,
              loop: current.run.loop,
              state: runState,
              openedAt: current.run.openedAt,
            }),
            step: current.step,
            repository: current.repository,
            revision: current.revision,
            task: current.task,
            agent: current.agent,
            parentModel: current.parentModel,
          }),
        });
      }),
    );
  }, persistence("begin attempt"));

  const succeedAttempt = Effect.fn("RunStore.succeedAttempt")(function* (
    attempt: Attempt,
    result: StepResult,
  ) {
    yield* database.transaction((transaction) =>
      Effect.gen(function* () {
        const tx = queriesFor(transaction);
        const current = yield* tx.snapshot(attempt.runId);
        if (current.run.state._tag !== "Running") return;
        yield* tx.closeAttempt(attempt.id, new AttemptSucceeded());
        yield* tx.updateStepResult(attempt.runId, attempt.stepName, result);
        yield* tx.updateState(attempt.runId, RunState.succeed(current.run.state));
        yield* tx.requestWorkflowCommand(attempt.runId, "Continue");
      }),
    );
  }, persistence("succeed attempt"));

  const failAttempt = Effect.fn("RunStore.failAttempt")(function* (
    attempt: Attempt,
    failure: AttemptFailure,
  ) {
    return yield* database.transaction((transaction) =>
      Effect.gen(function* () {
        const tx = queriesFor(transaction);
        const current = yield* tx.snapshot(attempt.runId);
        if (current.run.state._tag !== "Running") return false;
        yield* tx.closeAttempt(attempt.id, new AttemptFailed({ failure }));
        const retry = shouldAutoRetry({
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
  }, persistence("fail attempt"));

  const approve = Effect.fn("RunStore.approve")(function* (runId: RunId, approval: Event) {
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
        yield* tx.updateState(runId, RunState.approve(current.run.state));
        yield* tx.requestWorkflowCommand(runId, "Approve");
      }),
    );
  }, persistence("approve run"));

  const retry = Effect.fn("RunStore.retry")(function* (runId: RunId) {
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
  }, persistence("retry run"));

  const cancel = Effect.fn("RunStore.cancel")(function* (runId: RunId) {
    return yield* database.transaction((transaction) =>
      Effect.gen(function* () {
        const tx = queriesFor(transaction);
        const current = yield* tx.snapshot(runId);
        if (!RunState.isOpen(current.run.state)) {
          const alreadyClosed: CancelOutcome = { _tag: "AlreadyClosed" };
          return alreadyClosed;
        }
        let openAttempt = Option.none<AttemptId>();
        if (current.run.state._tag === "Running") {
          const attempt = current.attempts[current.attempts.length - 1];
          if (attempt !== undefined && Option.isNone(attempt.outcome)) {
            yield* tx.closeAttempt(attempt.id, new AttemptCanceled());
            openAttempt = Option.some(attempt.id);
          }
        }
        yield* tx.updateState(runId, RunState.cancelByOperator(current.run.state));
        yield* tx.requestInterrupt(runId);
        yield* tx.requestWorkflowCommand(runId, "Continue");
        const canceled: CancelOutcome = { _tag: "Canceled", openAttempt };
        return canceled;
      }),
    );
  }, persistence("cancel run"));

  const revoke = Effect.fn("RunStore.revoke")(function* (loop: LoopName, itemKey: ItemKey) {
    return yield* database.transaction((transaction) =>
      Effect.gen(function* () {
        const tx = queriesFor(transaction);
        const storedRuns = yield* tx.revokeUnstarted(loop, itemKey);
        for (const row of storedRuns) {
          const current = yield* tx.snapshot(row.runId);
          if (RunState.isUnstarted(current.run.state)) {
            yield* tx.updateState(row.runId, RunState.revoke(current.run.state));
            yield* tx.requestInterrupt(row.runId);
          }
        }
        return storedRuns.map((row) => row.runId);
      }),
    );
  }, persistence("revoke run"));

  const claimQueued = Effect.fn("RunStore.claimQueued")(function* (
    submission: Submission,
    runId: RunId,
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
  }, persistence("claim queued Event"));

  const recoverable = Effect.fn("RunStore.recoverable")(function* () {
    return (yield* queries.recoverable()).map(
      (row) =>
        new RecoverableRun({
          submission: submissionFromRow(row),
          runId: row.runId,
          state: row.state,
        }),
    );
  }, persistence("list recoverable runs"));

  const appendTranscript = Effect.fn("RunStore.appendTranscript")(function* (
    direction: AttemptChannel.Direction,
    envelope: AttemptChannel.Envelope,
  ) {
    const receivedAt = yield* DateTime.now;
    yield* database.transaction((transaction) =>
      Effect.gen(function* () {
        const tx = queriesFor(transaction);
        if (direction === "outbound" && envelope.payload._tag === "Started") {
          yield* tx.updateAttemptParentModel(envelope.attemptId, envelope.payload.parentModel);
        }
        yield* tx.appendTranscript(direction, envelope, receivedAt);
      }),
    );
  }, persistence("append Attempt transcript"));

  const transcript = Effect.fn("RunStore.transcript")(function* (query: TranscriptQuery) {
    return yield* queries.transcript(query);
  }, persistence("read Attempt transcript"));

  const reconcileCompletion = Effect.fn("RunStore.reconcileCompletion")(function* (
    runId: RunId,
    result: Workflow.Result<StepResult, AttemptFailure>,
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
          yield* tx.closeAttempt(attempt.id, new AttemptSucceeded());
          yield* tx.updateStepResult(attempt.runId, attempt.stepName, result.exit.value);
          yield* tx.updateState(runId, RunState.succeed(current.run.state));
          yield* tx.requestWorkflowCommand(runId, "Continue");
          return;
        }
        const failure = Cause.findErrorOption(result.exit.cause);
        if (Option.isNone(failure)) return;
        yield* tx.closeAttempt(attempt.id, new AttemptFailed({ failure: failure.value }));
        yield* tx.updateState(runId, RunState.fail(current.run.state));
        yield* tx.requestWorkflowCommand(runId, "Continue");
      }),
    );
  }, persistence("reconcile workflow completion"));

  return {
    approve,
    appendTranscript,
    beginAttempt,
    cancel,
    claimQueued,
    completeWorkflowCommand: (runId: RunId, command: WorkflowCommand) =>
      queries
        .completeWorkflowCommand(runId, command)
        .pipe(persistence("complete workflow command")),
    failAttempt,
    nextQueued: (runId: RunId) => queries.nextQueued(runId).pipe(persistence("find queued Event")),
    parkForApproval,
    pendingWorkflowCommands: queries
      .pendingWorkflowCommands()
      .pipe(persistence("list pending workflow commands")),
    recordAndClaim,
    reconcileCompletion,
    recoverable: recoverable(),
    retry,
    revoke,
    snapshot: (runId: RunId) => queries.snapshot(runId).pipe(persistence("read run")),
    succeedAttempt,
    transcript,
  } as const;
});

/**
 * The durable Run projection store. The interface below is the store's
 * declared contract — the seam any other backend (for example a Postgres
 * store) implements with its own `Layer.effect(RunStore, ...)`. Methods speak
 * domain vocabulary only and fail only with `RunStoreError`.
 */
export class RunStore extends Context.Service<
  RunStore,
  {
    readonly approve: (runId: RunId, approval: Event) => Effect.Effect<void, RunStoreError>;
    readonly appendTranscript: (
      direction: AttemptChannel.Direction,
      envelope: AttemptChannel.Envelope,
    ) => Effect.Effect<void, RunStoreError>;
    readonly beginAttempt: (
      runId: RunId,
      worker: WorkerName,
    ) => Effect.Effect<AttemptStarted | AttemptRecoveryFailed | RunClosed, RunStoreError>;
    readonly cancel: (runId: RunId) => Effect.Effect<CancelOutcome, RunStoreError>;
    readonly claimQueued: (
      submission: Submission,
      runId: RunId,
    ) => Effect.Effect<Option.Option<StoredSubmission>, RunStoreError>;
    readonly completeWorkflowCommand: (
      runId: RunId,
      command: WorkflowCommand,
    ) => Effect.Effect<void, RunStoreError>;
    readonly failAttempt: (
      attempt: Attempt,
      failure: AttemptFailure,
    ) => Effect.Effect<boolean, RunStoreError>;
    readonly nextQueued: (runId: RunId) => Effect.Effect<Option.Option<Submission>, RunStoreError>;
    readonly parkForApproval: (runId: RunId) => Effect.Effect<void, RunStoreError>;
    readonly pendingWorkflowCommands: Effect.Effect<
      ReadonlyArray<WorkflowCommandRow>,
      RunStoreError
    >;
    readonly recordAndClaim: (
      submission: Submission,
      requestedRunId: RunId,
    ) => Effect.Effect<Claim, RunStoreError>;
    readonly reconcileCompletion: (
      runId: RunId,
      result: Workflow.Result<StepResult, AttemptFailure>,
    ) => Effect.Effect<void, RunStoreError>;
    readonly recoverable: Effect.Effect<ReadonlyArray<RecoverableRun>, RunStoreError>;
    readonly retry: (runId: RunId) => Effect.Effect<void, RunStoreError>;
    readonly revoke: (
      loop: LoopName,
      itemKey: ItemKey,
    ) => Effect.Effect<ReadonlyArray<RunId>, RunStoreError>;
    readonly snapshot: (runId: RunId) => Effect.Effect<RunSnapshot, RunStoreError>;
    readonly succeedAttempt: (
      attempt: Attempt,
      result: StepResult,
    ) => Effect.Effect<void, RunStoreError>;
    readonly transcript: (
      query: TranscriptQuery,
    ) => Effect.Effect<ReadonlyArray<TranscriptEntry>, RunStoreError>;
  }
>()("@usine/engine/internal/RunStore") {
  static readonly layer = Layer.effect(RunStore, makeRunStore);
}
