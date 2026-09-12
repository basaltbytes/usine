import { Attempt, AttemptId, AttemptContext } from "@usine/core/attempt";
import * as AttemptChannel from "@usine/core/attempt/channel";
import { AttemptFailure, InfraFailure } from "@usine/core/attempt/failure";
import { Event } from "@usine/core/event";
import { ItemKey } from "@usine/core/item";
import { LoopName } from "@usine/core/loop";
import { RunId, Run } from "@usine/core/run";
import { WorkerName } from "@usine/core/worker";
import * as RunState from "@usine/core/run/state";
import { StepResult } from "@usine/core/step/result";
import {
  Cause,
  Context,
  DateTime,
  Effect,
  Exit,
  Layer,
  Match,
  Option,
  Result,
  Schema,
} from "effect";
import type { Workflow } from "effect/unstable/workflow";
import { RunDatabase } from "../database/database.ts";
import {
  Claimed,
  CycleBlocked,
  Ignored,
  Queued,
  Submission,
  SubmissionResult,
} from "../engine/submission.ts";
import { RunOperationRejectedError, type RunStoreError } from "../engine/error.ts";
import { RunSnapshot } from "../run-reader/model.ts";
import { StepExecution } from "../step-executor.ts";
import { TranscriptEntry, TranscriptQuery } from "../transcript.ts";
import type { WorkflowCommand } from "../workflow/command.ts";
import { persistence, submissionFromRow, type WorkflowCommandRow } from "./codec.ts";
import { queriesFor } from "./queries.ts";
import {
  beginAttempt as decideBeginAttempt,
  cancelRun,
  claimRun,
  finishAttempt as decideFinishAttempt,
  reconcileAttempt,
  retryRun,
  type FinishDecision,
} from "../engine/lifecycle.ts";

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
  result: SubmissionResult,
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
 * worker slot. Routine once capacity queues exist, never an error.
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
    const blocked = yield* tx.cycles.admit(submission);
    if (Option.isSome(blocked))
      return new Claim({
        submission,
        supersededRun,
        result: new CycleBlocked({ eventId: submission.event.id, ask: blocked.value }),
      });
    yield* tx.createRun(submission, submission.event.id, runId);
    yield* tx.cycles.reserve(submission, runId);
    return claimedRun(submission, runId, supersededRun);
  });

  const recordAndClaim = Effect.fn("RunStore.recordAndClaim")(function* (
    submission: Submission,
    requestedRunId: RunId,
  ) {
    yield* Effect.annotateCurrentSpan({
      eventId: submission.event.id,
      runId: requestedRunId,
      loop: submission.loop,
      itemKey: submission.itemKey,
    });
    return yield* database.transaction((transaction) =>
      Effect.gen(function* () {
        const tx = queriesFor(transaction);
        const recorded = yield* tx.recordTriggerEvent(submission);
        const existing = yield* tx.runForEvent(recorded.event.id);
        if (existing[0] !== undefined) {
          yield* Effect.logInfo("Event joined its existing Run", {
            eventId: recorded.event.id,
            runId: existing[0].runId,
          });
          return claimedRun(recorded, existing[0].runId);
        }

        const ignored = yield* tx.ignoredEvent(recorded.event.id);
        if (ignored[0] !== undefined) {
          yield* Effect.logInfo("Event remains ignored", {
            eventId: recorded.event.id,
            reason: ignored[0].reason,
          });
          return new Claim({
            submission: recorded,
            result: new Ignored({
              eventId: recorded.event.id,
              reason: ignored[0].reason,
            }),
            supersededRun: Option.none(),
          });
        }

        if (!(yield* tx.cycles.isCurrentEvent(recorded))) {
          return new Claim({
            submission: recorded,
            supersededRun: Option.none(),
            result: new Ignored({ eventId: recorded.event.id, reason: "superseded" }),
          });
        }
        const blocking = yield* tx.blockingRun(recorded.loop, recorded.itemKey);
        const blockedBy = blocking[0];
        const decision = claimRun(
          blockedBy === undefined
            ? Option.none()
            : Option.some((yield* tx.snapshot(blockedBy.runId)).run),
          recorded.event.id,
        );
        yield* Effect.logInfo("Event claim decided", {
          eventId: recorded.event.id,
          decision: decision._tag,
        });
        switch (decision._tag) {
          case "QueueEvent":
            return new Claim({
              submission: recorded,
              result: new Queued({ eventId: recorded.event.id }),
              supersededRun: Option.none(),
            });
          case "SupersedeRun":
            yield* tx.updateState(decision.runId, decision.state);
            yield* tx.requestInterrupt(decision.runId);
            return yield* openRun(tx, recorded, requestedRunId, Option.some(decision.runId));
          case "OpenRun":
            return yield* openRun(tx, recorded, requestedRunId);
        }
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

  // All callers supply a transaction: Attempt, Run, Step and outbox writes
  // either commit together or roll back together (ADRs 0010 and 0020).
  const applyFinish = Effect.fn("RunStore.applyFinish")(function* (
    tx: ReturnType<typeof queriesFor>,
    runId: RunId,
    decision: FinishDecision,
  ) {
    yield* Effect.annotateCurrentSpan({ runId });
    if (decision._tag === "Unchanged") {
      yield* Effect.logInfo("Attempt completion ignored", { runId, reason: decision.reason });
      return;
    }
    const { attempt, outcome } = decision;
    yield* Effect.annotateCurrentSpan({ attemptId: attempt.id });
    const fields = {
      runId,
      attemptId: attempt.id,
      number: attempt.number,
      decision: decision._tag,
    };
    yield* Effect.logInfo(
      "Attempt completion decided",
      Match.valueTags(outcome, {
        Failed: ({ failure }) => ({ ...fields, failure: failure._tag }),
        Succeeded: () => fields,
      }),
    );
    yield* tx.closeAttempt(attempt.id, outcome);
    if (decision._tag === "RetryAttempt") return;
    if (decision._tag === "RunSucceeded") {
      yield* tx.updateStepResult(runId, attempt.stepName, decision.result);
    }
    yield* tx.updateState(runId, decision.state);
    yield* tx.requestWorkflowCommand(runId, "Continue");
  });

  const beginAttempt = Effect.fn("RunStore.beginAttempt")(function* (
    runId: RunId,
    worker: WorkerName,
  ) {
    yield* Effect.annotateCurrentSpan({ runId });
    return yield* database.transaction((transaction) =>
      Effect.gen(function* () {
        const tx = queriesFor(transaction);
        const current = yield* tx.snapshot(runId);
        const interruption = new InfraFailure({
          message: "The orchestrator stopped during the attempt",
          cause: new Error("attempt interrupted by orchestrator restart"),
        });
        const decision = decideBeginAttempt(current, interruption);
        if (decision._tag === "RunClosed") {
          yield* Effect.logInfo("Attempt start skipped", { runId, state: decision.state._tag });
          return new RunClosed({ state: decision.state._tag });
        }
        if (decision._tag === "RunFailed") {
          yield* applyFinish(tx, runId, decision);
          return new AttemptRecoveryFailed({ failure: interruption });
        }
        if (Option.isSome(decision.interrupted)) {
          yield* applyFinish(tx, runId, decision.interrupted.value);
        }
        if (current.run.state._tag !== decision.state._tag) {
          yield* tx.updateState(runId, decision.state);
        }
        const attemptId = AttemptId.make(`${runId}/${current.step.name}/${decision.number}`);
        const startedAt = yield* DateTime.now;
        const attempt = new Attempt({
          id: attemptId,
          runId,
          stepName: current.step.name,
          worker,
          number: decision.number,
          brain: current.agent.brain,
          task: current.task,
          agent: current.agent.name,
          operatorIntervened: false,
          parentModel: current.parentModel,
          startedAt,
          outcome: Option.none(),
        });
        yield* tx.addAttempt(attempt);
        yield* Effect.logInfo("Attempt started", {
          runId,
          attemptId,
          number: decision.number,
          worker,
        });
        return new AttemptStarted({
          execution: new StepExecution({
            attempt,
            event: current.event,
            run: new Run({
              id: current.run.id,
              eventId: current.run.eventId,
              loop: current.run.loop,
              state: decision.state,
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

  const finishAttempt = Effect.fn("RunStore.finishAttempt")(function* (
    attempt: Attempt,
    result: Result.Result<StepResult, AttemptFailure>,
  ) {
    yield* Effect.annotateCurrentSpan({ runId: attempt.runId, attemptId: attempt.id });
    return yield* database.transaction((transaction) =>
      Effect.gen(function* () {
        const tx = queriesFor(transaction);
        const current = yield* tx.snapshot(attempt.runId);
        const decision = decideFinishAttempt(current, attempt.id, result);
        yield* applyFinish(tx, attempt.runId, decision);
        return decision;
      }),
    );
  }, persistence("finish attempt"));

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

  const retry = Effect.fn("RunStore.retry")(function* (
    runId: RunId,
    amendment: Option.Option<AttemptContext> = Option.none(),
  ) {
    yield* Effect.annotateCurrentSpan({ runId });
    yield* database.transaction((transaction) =>
      Effect.gen(function* () {
        const tx = queriesFor(transaction);
        const current = yield* tx.snapshot(runId);
        const decision = retryRun(current.run.state, yield* tx.workflowCommandsFor(runId));
        yield* Effect.logInfo("Operator retry decided", {
          runId,
          state: current.run.state._tag,
          decision: decision._tag,
        });
        if (decision._tag === "Resume") {
          if (Option.isSome(amendment)) {
            yield* tx.amend(runId, amendment.value);
            yield* Effect.logInfo("Run effective task and Agent amended", {
              runId,
              agent: amendment.value.agent.name,
            });
          }
          yield* tx.updateState(runId, decision.state);
          yield* tx.requestWorkflowCommand(runId, "Resume");
          return;
        }
        if (decision._tag === "ResumePending" && Option.isNone(amendment)) return;
        return yield* new RunOperationRejectedError({
          runId,
          operation: "retry",
          state: current.run.state._tag,
        });
      }),
    );
  }, persistence("retry run"));

  const cancel = Effect.fn("RunStore.cancel")(function* (runId: RunId) {
    yield* Effect.annotateCurrentSpan({ runId });
    return yield* database.transaction((transaction) =>
      Effect.gen(function* () {
        const tx = queriesFor(transaction);
        const current = yield* tx.snapshot(runId);
        const decision = cancelRun(current);
        yield* Effect.logInfo("Operator cancellation decided", {
          runId,
          state: current.run.state._tag,
          decision: decision._tag,
        });
        if (decision._tag === "AlreadyClosed") return decision;
        if (Option.isSome(decision.attempt)) {
          yield* tx.closeAttempt(decision.attempt.value.id, decision.attempt.value.outcome);
        }
        yield* tx.updateState(runId, decision.state);
        yield* tx.requestInterrupt(runId);
        yield* tx.requestWorkflowCommand(runId, "Continue");
        const canceled: CancelOutcome = {
          _tag: "Canceled",
          openAttempt: Option.map(decision.attempt, ({ id }) => id),
        };
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
        if (!(yield* tx.cycles.isCurrentEvent(submission))) return Option.none<StoredSubmission>();
        const claimed = yield* openRun(tx, submission, runId);
        return claimed.result._tag === "Claimed"
          ? Option.some(new StoredSubmission({ submission, runId }))
          : Option.none<StoredSubmission>();
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
        if (direction === "outbound" && envelope.payload._tag === "InterventionApplied") {
          yield* tx.markIntervened(envelope.attemptId);
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
    yield* Effect.annotateCurrentSpan({ runId });
    if (result._tag !== "Complete") {
      yield* Effect.logDebug("Workflow reconciliation skipped", { runId, reason: "Suspended" });
      return;
    }
    yield* database.transaction((transaction) =>
      Effect.gen(function* () {
        const tx = queriesFor(transaction);
        const current = yield* tx.snapshot(runId);
        // Workflow defects and interruption do not become typed Attempt failures.
        // Keep the projection available to the existing restart recovery path.
        const completion: Option.Option<Result.Result<StepResult, AttemptFailure>> = Exit.isSuccess(
          result.exit,
        )
          ? Option.some(Result.succeed(result.exit.value))
          : Option.map(Cause.findErrorOption(result.exit.cause), Result.fail);
        if (Option.isNone(completion)) {
          yield* Effect.logInfo("Workflow reconciliation skipped", {
            runId,
            reason: "NoTypedOutcome",
          });
          return;
        }
        yield* applyFinish(tx, runId, reconcileAttempt(current, completion.value));
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
    finishAttempt,
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
    transcript,
  } as const;
});

/**
 * The durable Run projection store. Another backend implements this interface
 * with its own `Layer.effect(RunStore, ...)`; methods speak domain vocabulary
 * and fail only with `RunStoreError`.
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
    /**
     * Records an executor result only if `attempt` is still the Run's open try.
     * The returned decision tells execution whether to retry; terminal outcomes,
     * the Step result and continuation request commit together.
     */
    readonly finishAttempt: (
      attempt: Attempt,
      result: Result.Result<StepResult, AttemptFailure>,
    ) => Effect.Effect<FinishDecision, RunStoreError>;
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
    readonly retry: (
      runId: RunId,
      amendment?: Option.Option<AttemptContext>,
    ) => Effect.Effect<void, RunStoreError>;
    readonly revoke: (
      loop: LoopName,
      itemKey: ItemKey,
    ) => Effect.Effect<ReadonlyArray<RunId>, RunStoreError>;
    readonly snapshot: (runId: RunId) => Effect.Effect<RunSnapshot, RunStoreError>;
    readonly transcript: (
      query: TranscriptQuery,
    ) => Effect.Effect<ReadonlyArray<TranscriptEntry>, RunStoreError>;
  }
>()("@usine/engine/internal/RunStore") {
  static readonly layer = Layer.effect(RunStore, makeRunStore);
}
