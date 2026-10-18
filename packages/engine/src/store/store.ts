import { Attempt, AttemptId, AttemptContext } from "@usine/core/attempt";
import * as AttemptChannel from "@usine/core/attempt/channel";
import { AttemptFailure, InfraFailure } from "@usine/core/attempt/failure";
import type { AttemptRecovery, AttemptSalvage } from "@usine/core/attempt/salvage";
import { Event, EventId } from "@usine/core/event";
import { ItemKey } from "@usine/core/item";
import { LoopName } from "@usine/core/loop";
import { RunId, Run } from "@usine/core/run";
import { WorkerName } from "@usine/core/worker";
import * as RunState from "@usine/core/run/state";
import { StepResult } from "@usine/core/step/result";
import { Context, Crypto, DateTime, Effect, Layer, Match, Option, Result, Schema } from "effect";
import { RunDatabase } from "../database/database.ts";
import {
  Claimed,
  CycleBlocked,
  Ignored,
  Queued,
  reopeningOf,
  runIdFor,
  Submission,
  SubmissionResult,
} from "../engine/submission.ts";
import {
  RunNotFoundError,
  RunOperationRejectedError,
  RunRetryBlockedError,
  type RunStoreError,
} from "../engine/error.ts";
import { RunSnapshot } from "../run-reader/model.ts";
import { StepExecution } from "../step-executor.ts";
import { TranscriptEntry, TranscriptQuery } from "../transcript.ts";
import { persistence, submissionFromRow } from "./codec.ts";
import { queriesFor, type QueuedEvents } from "./queries.ts";
import {
  beginAttempt as decideBeginAttempt,
  cameBack,
  cancelRun,
  claimRun,
  finishAttempt as decideFinishAttempt,
  resightEvent,
  retryRun,
  type FinishDecision,
  type Settlement,
} from "../engine/lifecycle.ts";

const OptionalRunId = Schema.Option(RunId).pipe(
  Schema.withConstructorDefault(Effect.succeed(Option.none<RunId>())),
);

/** What recording an Event did: its result, the Run it opened, and the unstarted Run it replaced. */
export class Claim extends Schema.Class<Claim>("@usine/engine/internal/Claim")({
  result: SubmissionResult,
  /** The Run this claim opened, which nothing drives yet; a joined Run is not repeated here. */
  openedRun: OptionalRunId,
  supersededRun: OptionalRunId,
}) {}

export class AttemptStarted extends Schema.TaggedClass<AttemptStarted>(
  "@usine/engine/internal/AttemptStarted",
)("AttemptStarted", {
  execution: StepExecution,
}) {}

/** Failing the Attempt a restart interrupted spent the Run's last automatic retry, so the Run failed. */
export class AttemptRecoveryFailed extends Schema.TaggedClass<AttemptRecoveryFailed>(
  "@usine/engine/internal/AttemptRecoveryFailed",
)("AttemptRecoveryFailed", {}) {}

/**
 * The Run closed (canceled, superseded, or revoked) while it waited for a
 * worker slot. Routine once capacity queues exist, never an error.
 */
export class RunClosed extends Schema.TaggedClass<RunClosed>("@usine/engine/internal/RunClosed")(
  "RunClosed",
  {},
) {}

/** What `RunStore.cancel` did, decided inside the closing transaction. */
export type CancelOutcome =
  | { readonly _tag: "AlreadyClosed" }
  | { readonly _tag: "Canceled"; readonly openAttempt: Option.Option<AttemptId> };

const makeRunStore = Effect.gen(function* () {
  const database = yield* RunDatabase;
  const crypto = yield* Crypto.Crypto;
  const queries = queriesFor(database);

  const openRun = Effect.fn("RunStore.openRun")(function* (
    tx: ReturnType<typeof queriesFor>,
    submission: Submission,
    runId: RunId,
    supersededRun: Option.Option<RunId> = Option.none(),
  ) {
    const blocked = yield* tx.cycles.admit(submission);
    if (Option.isSome(blocked))
      return new Claim({
        result: new CycleBlocked({ eventId: submission.event.id, ask: blocked.value }),
        supersededRun,
      });
    yield* tx.createRun(submission, submission.event.id, runId);
    yield* tx.cycles.reserve(submission, runId);
    return new Claim({
      result: new Claimed({ eventId: submission.event.id, runId }),
      openedRun: Option.some(runId),
      supersededRun,
    });
  });

  const runIdOf = (submission: Submission) =>
    runIdFor(submission).pipe(Effect.provideService(Crypto.Crypto, crypto));

  /** The Run the Event owns, or the reason it was ignored; none for an Event still to claim. */
  const settlementOf = Effect.fn("RunStore.settlementOf")(function* (
    tx: ReturnType<typeof queriesFor>,
    eventId: EventId,
  ) {
    const owner = (yield* tx.runForEvent(eventId))[0];
    if (owner !== undefined) {
      const run = (yield* tx.snapshot(owner.runId)).run;
      return Option.some<Settlement>({ _tag: "Owned", run });
    }
    const ignored = (yield* tx.ignoredEvent(eventId))[0];
    return ignored === undefined
      ? Option.none<Settlement>()
      : Option.some<Settlement>({ _tag: "Ignored", reason: ignored.reason });
  });

  /** Claims a recorded Event that owns no Run and was not ignored: queue it, or open its Run as `runId`. */
  const claimEvent = Effect.fn("RunStore.claimEvent")(function* (
    tx: ReturnType<typeof queriesFor>,
    recorded: Submission,
    runId: RunId,
  ) {
    if (!(yield* tx.cycles.isCurrentEvent(recorded))) {
      return new Claim({
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
        return new Claim({ result: new Queued({ eventId: recorded.event.id }) });
      case "SupersedeRun":
        yield* tx.updateState(decision.runId, decision.state);
        return yield* openRun(tx, recorded, runId, Option.some(decision.runId));
      case "OpenRun":
        return yield* openRun(tx, recorded, runId);
    }
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
        const previous = yield* tx.loopItems.sighted(
          recorded.loop,
          recorded.itemKey,
          recorded.event.id,
        );
        // After a reopening, later sightings of the trigger's Event belong to the newest one.
        const current = Option.getOrElse(yield* tx.newestReopening(recorded.event.id), () => ({
          submission: recorded,
          reopening: 0,
        }));
        const eventId = current.submission.event.id;
        const settled = yield* settlementOf(tx, eventId);
        if (Option.isNone(settled)) {
          return yield* claimEvent(
            tx,
            current.submission,
            current.reopening === 0 ? requestedRunId : yield* runIdOf(current.submission),
          );
        }
        const decision = resightEvent(settled.value, cameBack(previous, recorded.event.id));
        switch (decision._tag) {
          case "JoinRun":
            yield* Effect.logInfo("Event joined its existing Run", {
              eventId,
              runId: decision.run.id,
              state: decision.run.state._tag,
            });
            return new Claim({ result: new Claimed({ eventId, runId: decision.run.id }) });
          case "StayIgnored":
            yield* Effect.logInfo("Event remains ignored", { eventId, reason: decision.reason });
            return new Claim({ result: new Ignored({ eventId, reason: decision.reason }) });
          case "ReopenEvent": {
            const reopening = current.reopening + 1;
            const reopened = yield* tx.recordTriggerEvent(
              reopeningOf(submission, recorded.event.dedupKey, reopening),
              Option.some({ eventId: recorded.event.id, reopening }),
            );
            yield* Effect.logInfo(
              "The Item came back to the state of an Event no Attempt worked on; it opens again",
              {
                eventId,
                settled: settled.value._tag,
                reopenedEventId: reopened.event.id,
                reopening,
              },
            );
            return yield* claimEvent(tx, reopened, yield* runIdOf(reopened));
          }
        }
      }),
    );
  }, persistence("submit Event"));

  const parkForApproval = Effect.fn("RunStore.parkForApproval")(function* (runId: RunId) {
    yield* Effect.annotateCurrentSpan({ runId });
    return yield* database.transaction((transaction) =>
      Effect.gen(function* () {
        const tx = queriesFor(transaction);
        const current = yield* tx.snapshot(runId);
        if (current.run.state._tag !== "Pending") return current.run.state;
        const waiting = RunState.awaitApproval(current.run.state);
        yield* tx.updateState(runId, waiting);
        return waiting;
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
  });

  const executionOf = (
    current: RunSnapshot,
    {
      attempt,
      state,
      resume,
      reattach,
    }: Pick<StepExecution, "attempt" | "resume" | "reattach"> & {
      readonly state: RunState.Running;
    },
  ) =>
    new StepExecution({
      attempt,
      event: current.event,
      run: new Run({
        id: current.run.id,
        eventId: current.run.eventId,
        loop: current.run.loop,
        state,
        openedAt: current.run.openedAt,
      }),
      step: current.step,
      repository: current.repository,
      revision: current.revision,
      task: current.task,
      agent: current.agent,
      parentModel: current.parentModel,
      resume,
      reattach,
    });

  const beginAttempt = Effect.fn("RunStore.beginAttempt")(function* (
    runId: RunId,
    worker: WorkerName,
    live: Option.Option<AttemptId>,
  ) {
    yield* Effect.annotateCurrentSpan({ runId, worker });
    return yield* database.transaction((transaction) =>
      Effect.gen(function* () {
        const tx = queriesFor(transaction);
        const current = yield* tx.snapshot(runId);
        const interruption = new InfraFailure({
          message: "The orchestrator stopped during the attempt",
          cause: new Error("attempt interrupted by orchestrator restart"),
        });
        const decision = decideBeginAttempt(current, interruption, live);
        if (decision._tag === "RunClosed") {
          yield* Effect.logInfo("Attempt start skipped", { runId, state: decision.state._tag });
          return new RunClosed();
        }
        if (decision._tag === "RunFailed") {
          yield* applyFinish(tx, runId, decision);
          return new AttemptRecoveryFailed();
        }
        if (decision._tag === "ReattachAttempt") {
          const attempt = decision.attempt;
          yield* Effect.annotateCurrentSpan({ attemptId: attempt.id });
          yield* Effect.logInfo("Attempt reattached after an orchestrator restart", {
            runId,
            attemptId: attempt.id,
            number: attempt.number,
            worker: attempt.worker,
          });
          if (attempt.worker !== worker) {
            // The parent task and its checkout stay where they started.
            yield* Effect.logWarning(
              "Reattached Attempt keeps its own Worker, not the reserved one",
              {
                runId,
                attemptId: attempt.id,
                worker: attempt.worker,
                reservedWorker: worker,
              },
            );
          }
          return new AttemptStarted({
            execution: executionOf(current, {
              attempt,
              state: decision.state,
              resume: decision.resume,
              reattach: true,
            }),
          });
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
          salvage: Option.none(),
        });
        yield* tx.addAttempt(attempt);
        yield* Effect.logInfo("Attempt started", {
          runId,
          attemptId,
          number: decision.number,
          worker,
          resumesFrom: Option.map(decision.resume, ({ ref }) => ref),
        });
        return new AttemptStarted({
          execution: executionOf(current, {
            attempt,
            state: decision.state,
            resume: decision.resume,
            reattach: false,
          }),
        });
      }),
    );
  }, persistence("begin attempt"));

  const recordSalvage = Effect.fn("RunStore.recordSalvage")(function* (
    attemptId: AttemptId,
    salvage: AttemptSalvage,
  ) {
    yield* Effect.annotateCurrentSpan({ attemptId, salvage: salvage._tag });
    yield* database.transaction((transaction) =>
      queriesFor(transaction).recordSalvage(attemptId, salvage),
    );
    yield* Effect.logInfo(
      "Attempt salvage recorded",
      Match.valueTags(salvage, {
        Pushed: ({ ref, commit }) => ({ attemptId, ref, commit }),
        Retained: ({ path, commit }) => ({ attemptId, path, commit }),
      }),
    );
  }, persistence("record attempt salvage"));

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

  const resolveFailure = Effect.fn("RunStore.resolveFailure")(function* (
    runId: RunId,
    attemptId: AttemptId,
  ) {
    yield* Effect.annotateCurrentSpan({ runId, attemptId });
    yield* database.transaction((transaction) =>
      Effect.gen(function* () {
        const tx = queriesFor(transaction);
        const current = yield* tx.snapshot(runId);
        const latest = current.attempts.at(-1);
        if (
          !RunState.operatorActions(current.run.state).canResolveFailure ||
          latest?.id !== attemptId
        ) {
          yield* Effect.logInfo("Failure resolution rejected; Run or Attempt changed", {
            runId,
            attemptId,
            state: current.run.state._tag,
            latestAttemptId: latest?.id,
          });
          return yield* new RunOperationRejectedError({
            runId,
            operation: "resolveFailure",
            state: current.run.state._tag,
          });
        }
        if (Option.contains(current.resolvedFailureAttemptId, attemptId)) {
          yield* Effect.logInfo("Run failure already resolved", { runId, attemptId });
          return;
        }
        yield* tx.resolveFailure(runId, attemptId);
        yield* Effect.logInfo("Run failure resolved", { runId, attemptId });
      }),
    );
  }, persistence("resolve Run failure"));

  const approve = Effect.fn("RunStore.approve")(function* (runId: RunId, approval: Event) {
    yield* Effect.annotateCurrentSpan({ runId, eventId: approval.id });
    return yield* database.transaction((transaction) =>
      Effect.gen(function* () {
        const tx = queriesFor(transaction);
        if (yield* tx.approvalExists(runId)) return false;
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
        return true;
      }),
    );
  }, persistence("approve run"));

  const retry = Effect.fn("RunStore.retry")(function* (
    runId: RunId,
    amendment: Option.Option<AttemptContext> = Option.none(),
  ) {
    yield* Effect.annotateCurrentSpan({ runId });
    return yield* database.transaction((transaction) =>
      Effect.gen(function* () {
        const tx = queriesFor(transaction);
        const current = yield* tx.snapshot(runId);
        const decision = retryRun(current);
        yield* Effect.logInfo("Operator retry decided", {
          runId,
          state: current.run.state._tag,
          decision: decision._tag,
        });
        if (decision._tag === "Resume") {
          // A Failed Run is closed, so a later Event may have opened another Run
          // of this Loop on the Item. Reopening this one would run both at once.
          const blocking = (yield* tx.blockingRun(current.run.loop, current.itemKey))[0];
          if (blocking !== undefined) {
            yield* Effect.logInfo("Operator retry rejected; another Run is open on the Item", {
              runId,
              openRunId: blocking.runId,
              loop: current.run.loop,
              itemKey: current.itemKey,
            });
            return yield* new RunRetryBlockedError({
              runId,
              openRunId: blocking.runId,
              message: `Cannot retry Run ${runId}: Run ${blocking.runId} of Loop ${current.run.loop} is open on the same Item. Retry after it closes, or cancel it first.`,
            });
          }
          if (Option.isSome(amendment)) {
            yield* tx.amend(runId, amendment.value);
            yield* Effect.logInfo("Run effective task and Agent amended", {
              runId,
              agent: amendment.value.agent.name,
            });
          }
          yield* tx.updateState(runId, decision.state);
          return true;
        }
        if (decision._tag === "ResumePending" && Option.isNone(amendment)) return false;
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
        yield* tx.loopItems.unmatched(loop, itemKey);
        const storedRuns = yield* tx.revokeUnstarted(loop, itemKey);
        for (const row of storedRuns) {
          const current = yield* tx.snapshot(row.runId);
          if (RunState.isUnstarted(current.run.state)) {
            yield* tx.updateState(row.runId, RunState.revoke(current.run.state));
          }
        }
        return storedRuns.map((row) => row.runId);
      }),
    );
  }, persistence("revoke run"));

  const revokeQueued = Effect.fn("RunStore.revokeQueued")(function* (queued: QueuedEvents) {
    const { loop, itemKey, event } = queued.submission;
    yield* Effect.annotateCurrentSpan({ loop, itemKey, eventId: event.id });
    // Not a sighting: the trigger may still submit the Event from a fetch made
    // before the closing Run changed the Item, and that Event must stay ignored.
    return yield* queries.revokeQueued(loop, itemKey, queued.eventIds);
  }, persistence("revoke queued Events"));

  const claimQueued = Effect.fn("RunStore.claimQueued")(function* (
    submission: Submission,
    runId: RunId,
  ) {
    return yield* database.transaction((transaction) =>
      Effect.gen(function* () {
        const tx = queriesFor(transaction);
        const existing = yield* tx.runForEvent(submission.event.id);
        if (existing[0] !== undefined) {
          yield* Effect.logInfo("Queued Event already opened its Run", {
            eventId: submission.event.id,
            runId: existing[0].runId,
          });
          return Option.none<RunId>();
        }
        if ((yield* tx.ignoredEvent(submission.event.id)).length > 0) {
          return Option.none<RunId>();
        }
        if ((yield* tx.blockingRun(submission.loop, submission.itemKey)).length > 0) {
          return Option.none<RunId>();
        }
        if (!(yield* tx.cycles.isCurrentEvent(submission))) return Option.none<RunId>();
        return (yield* openRun(tx, submission, runId)).openedRun;
      }),
    );
  }, persistence("claim queued Event"));

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
        if (!(yield* tx.appendTranscript(direction, envelope, receivedAt)))
          yield* Effect.logDebug("Transcript envelope already recorded; keeping the first copy", {
            attemptId: envelope.attemptId,
            direction,
            sequence: envelope.sequence,
          });
      }),
    );
  }, persistence("append Attempt transcript"));

  const transcript = Effect.fn("RunStore.transcript")(function* (query: TranscriptQuery) {
    return yield* queries.transcript(query);
  }, persistence("read Attempt transcript"));

  return {
    approve,
    appendTranscript,
    beginAttempt,
    cancel,
    claimQueued,
    finishAttempt,
    nextQueued: (runId: RunId) => queries.nextQueued(runId).pipe(persistence("find queued Event")),
    parkForApproval,
    pendingContinuations: queries
      .pendingContinuations()
      .pipe(persistence("list pending continuations")),
    runIdsToDrive: queries.runIdsToDrive().pipe(persistence("list the Runs to drive")),
    recordAndClaim,
    salvageCandidates: queries.salvageCandidates().pipe(persistence("list salvage candidates")),
    recordSalvage,
    submission: (runId: RunId) =>
      queries.eventRouteByRun(runId).pipe(
        Effect.flatMap((routes) =>
          routes[0] === undefined
            ? Effect.fail(new RunNotFoundError({ runId }))
            : Effect.succeed(submissionFromRow(routes[0])),
        ),
        persistence("read run submission"),
      ),
    resolveFailure,
    retry,
    revoke,
    revokeQueued,
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
    /** Records the approval and lets the waiting Run queue for a Worker. True when this call recorded it; a repeated approval changes nothing. */
    readonly approve: (runId: RunId, approval: Event) => Effect.Effect<boolean, RunStoreError>;
    readonly appendTranscript: (
      direction: AttemptChannel.Direction,
      envelope: AttemptChannel.Envelope,
    ) => Effect.Effect<void, RunStoreError>;
    /**
     * Admits the Run's next Attempt on `worker`. `live` names the Run's open
     * Attempt whose parent task outlived a restart, if any: that Attempt is
     * reattached; any other open Attempt is failed and the next one opens.
     */
    readonly beginAttempt: (
      runId: RunId,
      worker: WorkerName,
      live: Option.Option<AttemptId>,
    ) => Effect.Effect<AttemptStarted | AttemptRecoveryFailed | RunClosed, RunStoreError>;
    readonly cancel: (runId: RunId) => Effect.Effect<CancelOutcome, RunStoreError>;
    /** Opens the queued Event's Run as `runId` when the Item has no open Run; none when the Event cannot open one now. */
    readonly claimQueued: (
      submission: Submission,
      runId: RunId,
    ) => Effect.Effect<Option.Option<RunId>, RunStoreError>;
    /**
     * Records an executor result only if `attempt` is still the Run's open try.
     * The returned decision tells execution whether to retry; the Attempt's
     * outcome, the Step result and the Run's closing state commit together.
     */
    readonly finishAttempt: (
      attempt: Attempt,
      result: Result.Result<StepResult, AttemptFailure>,
    ) => Effect.Effect<FinishDecision, RunStoreError>;
    readonly nextQueued: (
      runId: RunId,
    ) => Effect.Effect<Option.Option<QueuedEvents>, RunStoreError>;
    /** Moves a pending Run to `Waiting` and returns the Run's state, which stays `Waiting` until an approval arrives. */
    readonly parkForApproval: (runId: RunId) => Effect.Effect<RunState.RunState, RunStoreError>;
    /** The closed Runs whose Item still has a queued Event that no continuation has opened or revoked. */
    readonly pendingContinuations: Effect.Effect<ReadonlyArray<RunId>, RunStoreError>;
    /**
     * Every open Run a fiber drives: pending, queued for a Worker, or running. A
     * Run waiting for its approval is left out; its approval starts its fiber.
     */
    readonly runIdsToDrive: Effect.Effect<ReadonlyArray<RunId>, RunStoreError>;
    /**
     * Records a trigger's Event as what its Loop last saw of the Item, then claims
     * it: `requestedRunId` names the Run the Event opens. When the Item came back
     * to the state of an Event whose Run was canceled, the Event opens again as a
     * reopening whose Run id derives from its own dedup key (#267).
     */
    readonly recordAndClaim: (
      submission: Submission,
      requestedRunId: RunId,
    ) => Effect.Effect<Claim, RunStoreError>;
    /** Records what the executor preserved of an Attempt's workspace, whatever the Attempt's outcome. */
    readonly recordSalvage: (
      attemptId: AttemptId,
      salvage: AttemptSalvage,
    ) => Effect.Effect<void, RunStoreError>;
    readonly salvageCandidates: Effect.Effect<ReadonlyArray<AttemptRecovery>, RunStoreError>;
    /** Resolves attention for the current failed Attempt atomically; stale requests are rejected. */
    readonly resolveFailure: (
      runId: RunId,
      attemptId: AttemptId,
    ) => Effect.Effect<void, RunStoreError>;
    /**
     * Reopens a failed Run for its next Attempt. True when this call reopened it;
     * a request while the Run runs between Attempts changes nothing. Fails with
     * `RunRetryBlockedError` while another Run of the same Loop and Item is open.
     */
    readonly retry: (
      runId: RunId,
      amendment?: Option.Option<AttemptContext>,
    ) => Effect.Effect<boolean, RunStoreError>;
    /** Records that the Loop saw the Item not matching, and revokes its unstarted Runs and queued Events. */
    readonly revoke: (
      loop: LoopName,
      itemKey: ItemKey,
    ) => Effect.Effect<ReadonlyArray<RunId>, RunStoreError>;
    /** Revokes only observed Events that remain unclaimed; preserves later arrivals and returns the count. */
    readonly revokeQueued: (queued: QueuedEvents) => Effect.Effect<number, RunStoreError>;
    readonly snapshot: (runId: RunId) => Effect.Effect<RunSnapshot, RunStoreError>;
    /** The Submission that opened the Run, as its trigger Event recorded it. */
    readonly submission: (runId: RunId) => Effect.Effect<Submission, RunStoreError>;
    readonly transcript: (
      query: TranscriptQuery,
    ) => Effect.Effect<ReadonlyArray<TranscriptEntry>, RunStoreError>;
  }
>()("@usine/engine/internal/RunStore") {
  static readonly layer = Layer.effect(RunStore, makeRunStore);
}
