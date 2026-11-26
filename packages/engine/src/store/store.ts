import { TranscriptCodec } from "./transcript/codec.ts";
import { InstanceScope } from "@usine/core/access";
import { BillingPools } from "@usine/core/agent/pool";
import { ChangeBus } from "@usine/core/changes";
import { changeTransaction } from "./changes.ts";
import type { CiResolution } from "@usine/core/ci";
import type { CommitSha } from "@usine/core/repository";
import { ciQueries } from "./ci.ts";
import {
  Attempt,
  AttemptId,
  type AttemptWindows,
  type ContainerOutOfMemoryKills,
} from "@usine/core/attempt";
import * as AttemptChannel from "@usine/core/attempt/channel";
import type { AttemptRecovery, AttemptSalvage } from "@usine/core/attempt/salvage";
import { Event } from "@usine/core/event";
import { ItemKey } from "@usine/core/item";
import { LoopName } from "@usine/core/loop";
import type { OperatorActor } from "@usine/core/operator";
import { RunId } from "@usine/core/run";
import { ApprovalSource } from "@usine/core/run/approval";
import { type WorkerKind, WorkerName } from "@usine/core/worker";
import * as RunState from "@usine/core/run/state";
import { type Comment } from "@usine/core/step/result";
import { Context, DateTime, Effect, Layer, Match, Option } from "effect";
import { ReadSnapshot, RunDatabase } from "../database/database.ts";
import { type RevokeScope, Submission } from "../engine/submission.ts";
import { EnginePersistenceError, RunNotFoundError, type RunStoreError } from "../engine/error.ts";
import { RunSnapshot } from "../run-reader/model.ts";
import type { RunAgainRequest, RunAgainResult } from "../engine/run-again.ts";
import type { CapacityWait } from "../engine/capacity/state.ts";
import type { RetryOutcome, RetryRequest } from "../engine/retry.ts";
import { TranscriptEntry, TranscriptQuery } from "../transcript.ts";
import { leftoverQueries } from "./queries/leftovers.ts";
import { persistence, submissionFromRow } from "./codec.ts";
import { queriesFor, runTransaction } from "./queries/queries.ts";
import type { PendingQueue, QueuedEvents } from "./queries/queue.ts";
import type { FinishDecision, AttemptResult } from "../engine/lifecycle.ts";
import {
  type AttemptRecoveryFailed,
  type AttemptStarted,
  attemptOperations,
  type RunClosed,
} from "./attempts.ts";
import { type Claim, claimOperations } from "./claims.ts";
import { type CancelOutcome, operatorActions } from "./operator-actions.ts";
import { poolResetNotices } from "./pool-resets.ts";

/** A persisted Attempt that startup reconciliation visits, with its Run and the Run's Loop and Item. */
export interface SalvageCandidate extends AttemptRecovery {
  readonly runId: RunId;
  readonly loop: LoopName;
  readonly itemKey: ItemKey;
}

const makeRunStore = Effect.gen(function* () {
  const database = yield* RunDatabase;
  const readSnapshot = yield* ReadSnapshot;
  const bus = yield* ChangeBus;
  const transact = changeTransaction(database, bus);
  const codec = yield* TranscriptCodec;
  const inTransaction = runTransaction(database, bus, codec);
  const pools = yield* BillingPools;
  const queries = queriesFor(database, codec);
  const poolResets = yield* poolResetNotices;
  const claims = yield* claimOperations;
  const attempts = yield* attemptOperations;
  const actions = yield* operatorActions;

  const recordSalvage = Effect.fn("RunStore.recordSalvage")(function* (
    attemptId: AttemptId,
    salvage: AttemptSalvage,
  ) {
    yield* Effect.annotateCurrentSpan({ attemptId, salvage: salvage._tag });
    yield* inTransaction((tx) => tx.recordSalvage(attemptId, salvage));
    yield* Effect.logInfo(
      "Attempt salvage recorded",
      Match.valueTags(salvage, {
        Pushed: ({ ref, commit }) => ({ attemptId, ref, commit }),
        PartlyPushed: ({ ref, commit, path }) => ({ attemptId, ref, commit, path }),
        Retained: ({ path, commit, pushFailure }) => ({
          attemptId,
          path,
          commit,
          pushFailure: Option.map(pushFailure, ({ message }) => message),
        }),
        Rejected: ({ path, commit }) => ({ attemptId, path, commit }),
      }),
    );
  }, persistence("record attempt salvage"));

  const recordComments = Effect.fn("RunStore.recordComments")(function* (
    attemptId: AttemptId,
    comments: ReadonlyArray<Comment>,
  ) {
    yield* Effect.annotateCurrentSpan({ attemptId, comments: comments.length });
    yield* inTransaction((tx) => tx.recordComments(attemptId, comments));
    yield* Effect.logInfo(
      "Recorded the comments an Attempt posted before it ended without success",
      {
        attemptId,
        comments: comments.map(({ kind, url }) => `${kind} ${url.href}`),
      },
    );
  }, persistence("record attempt comments"));

  const recordOutOfMemory = Effect.fn("RunStore.recordOutOfMemory")(function* (
    attemptId: AttemptId,
    kills: ContainerOutOfMemoryKills,
  ) {
    yield* Effect.annotateCurrentSpan({
      attemptId,
      container: kills.container,
      kills: kills.kills,
    });
    const attempt = yield* inTransaction((tx) => tx.recordOutOfMemory(attemptId, kills));
    yield* Effect.logInfo("Recorded the processes the kernel killed in the Attempt's container", {
      attemptId,
      container: kills.container,
      kills: kills.kills,
      memoryMib: kills.memoryMib,
      processes: kills.processes,
      attemptKills: attempt.kills,
    });
  }, persistence("record attempt out-of-memory kills"));

  const attemptWindows = Effect.fn("RunStore.attemptWindows")(function* (attemptId: AttemptId) {
    yield* Effect.annotateCurrentSpan({ attemptId });
    const windows = yield* queries.attemptWindows(attemptId);
    yield* Effect.logDebug(
      "Read the Attempt's window and the Attempts of the same Agent that overlap it on its Item",
      {
        attemptId,
        recorded: Option.isSome(windows.own),
        ended: Option.exists(windows.own, ({ endedAt }) => Option.isSome(endedAt)),
        overlapping: windows.overlapping.map((window) => window.attemptId),
      },
    );
    return windows;
  }, persistence("read attempt windows"));

  const discardLeftovers = Effect.fn("RunStore.discardLeftovers")(function* (worker: WorkerName) {
    yield* Effect.annotateCurrentSpan({ worker });
    const discardedAt = yield* DateTime.now;
    return yield* transact((transaction, record) =>
      leftoverQueries(transaction)
        .discardLeftovers(worker, discardedAt)
        .pipe(
          Effect.tap(() =>
            record({ audience: InstanceScope.make(), target: { kind: "worker", id: worker } }),
          ),
        ),
    );
  }, persistence("discard attempt leftovers"));

  const discardClosedAttempt = Effect.fn("RunStore.discardClosedAttempt")(function* (
    attemptId: AttemptId,
  ) {
    yield* Effect.annotateCurrentSpan({ attemptId });
    const discardedAt = yield* DateTime.now;
    const worker = yield* transact((transaction, record) =>
      leftoverQueries(transaction)
        .discardClosedAttempt(attemptId, discardedAt)
        .pipe(
          Effect.tap(
            Option.match({
              onNone: () => Effect.void,
              onSome: (worker) =>
                record({ audience: InstanceScope.make(), target: { kind: "worker", id: worker } }),
            }),
          ),
        ),
    );
    return Option.isSome(worker);
  }, persistence("discard a closed attempt's leftovers"));

  const openAttempts = Effect.fn("RunStore.openAttempts")(function* (worker: WorkerName) {
    yield* Effect.annotateCurrentSpan({ worker });
    return yield* leftoverQueries(database).openAttempts(worker);
  }, persistence("count open attempts"));

  const appendTranscript = Effect.fn("RunStore.appendTranscript")(function* (
    direction: AttemptChannel.Direction,
    envelope: AttemptChannel.Envelope,
  ) {
    const receivedAt = yield* DateTime.now;
    const inserted = yield* inTransaction((tx) =>
      Effect.gen(function* () {
        if (!(yield* tx.appendTranscript(direction, envelope, receivedAt, pools))) {
          yield* Effect.logDebug("Transcript envelope already recorded; keeping the first copy", {
            attemptId: envelope.attemptId,
            direction,
            sequence: envelope.sequence,
          });
          return false;
        }
        if (direction === "outbound" && envelope.payload._tag === "Started") {
          yield* tx.updateAttemptParentModel(envelope.attemptId, envelope.payload.parentModel);
        }
        if (direction === "outbound" && envelope.payload._tag === "InterventionApplied") {
          yield* tx.markIntervened(envelope.attemptId);
        }
        yield* tx.changedAttempt(envelope.attemptId);
        return true;
      }),
    );
    if (
      inserted &&
      direction === "outbound" &&
      envelope.payload._tag === "SessionEvent" &&
      envelope.payload.event._tag === "PoolRateLimitsUpdated"
    ) {
      yield* poolResets.schedule(envelope.payload.event);
    }
  }, persistence("append attempt transcript"));

  const transcript = Effect.fn("RunStore.transcript")(function* (query: TranscriptQuery) {
    return yield* readSnapshot.run(database, queries.transcript(query));
  }, persistence("read attempt transcript"));

  return {
    ...ciQueries(database, bus, codec),
    ...claims,
    ...attempts,
    ...actions,
    appendTranscript,
    nextQueued: (runId: RunId) => queries.nextQueued(runId).pipe(persistence("find queued event")),
    admissibleQueue: (loop: LoopName, itemKey: ItemKey) =>
      queries
        .admissibleQueue(loop, itemKey)
        .pipe(persistence("find admissible queued events on a loop item")),
    pendingQueues: queries.pendingQueues().pipe(persistence("list pending queues")),
    runIdsToDrive: queries.runIdsToDrive().pipe(persistence("list the runs to drive")),
    salvageCandidates: queries.salvageCandidates().pipe(persistence("list salvage candidates")),
    salvageCandidate: (attemptId: AttemptId) =>
      queries.salvageCandidate(attemptId).pipe(persistence("read a salvage candidate")),
    recordSalvage,
    recordComments,
    recordOutOfMemory,
    attemptWindows,
    discardLeftovers,
    discardClosedAttempt,
    openAttempts,
    submission: (runId: RunId) =>
      queries.eventRouteByRun(runId).pipe(
        Effect.flatMap((routes) =>
          routes[0] === undefined
            ? Effect.fail(RunNotFoundError.make({ runId }))
            : Effect.succeed(submissionFromRow(routes[0])),
        ),
        persistence("read run submission"),
      ),
    snapshot: (runId: RunId) =>
      database
        .transaction((transaction) => queriesFor(transaction, codec).snapshot(runId))
        .pipe(persistence("read run")),
    transcript,
  } as const;
});

/** The durable Run store; its methods fail only with `RunStoreError`. */
export class RunStore extends Context.Service<
  RunStore,
  {
    readonly awaitingCi: Effect.Effect<ReadonlyArray<RunSnapshot>, EnginePersistenceError>;
    readonly settleCi: (
      runId: RunId,
      head: CommitSha,
      resolution: CiResolution,
    ) => Effect.Effect<boolean, RunStoreError>;
    /**
     * Records the approval Event and its source, and queues the waiting Run for a Worker. Returns
     * whether this call recorded it; a repeated approval changes nothing.
     */
    readonly approve: (
      runId: RunId,
      approval: Event,
      source: ApprovalSource,
    ) => Effect.Effect<boolean, RunStoreError>;
    readonly appendTranscript: (
      direction: AttemptChannel.Direction,
      envelope: AttemptChannel.Envelope,
    ) => Effect.Effect<void, RunStoreError>;
    /**
     * Starts the Run's next Attempt on `worker`, of kind `kind`. If `live` is the open Attempt,
     * reattaches it and keeps its recorded kind; otherwise fails any open Attempt first.
     */
    readonly beginAttempt: (
      runId: RunId,
      worker: WorkerName,
      kind: WorkerKind,
      live: Option.Option<AttemptId>,
    ) => Effect.Effect<AttemptStarted | AttemptRecoveryFailed | RunClosed, RunStoreError>;
    readonly cancel: (runId: RunId) => Effect.Effect<CancelOutcome, RunStoreError>;
    /**
     * Opens the queued Event's Run as `runId` if the Item has no open Run, or returns `None`. The
     * Event keeps the Loop settings of `submission`, which a recheck may have refreshed.
     */
    readonly claimQueued: (
      submission: Submission,
      runId: RunId,
    ) => Effect.Effect<Option.Option<RunId>, RunStoreError>;
    /**
     * Records an executor result if `attempt` is still the Run's open Attempt, committing its
     * outcome, the Step result, and the Run state together. A question or blocker also starts the
     * Loop's suppression of the Item. A rejected report fails the Attempt, which keeps its result.
     */
    readonly finishAttempt: (
      attempt: Attempt,
      result: AttemptResult,
    ) => Effect.Effect<FinishDecision, RunStoreError>;
    /** Returns the queued Events of the Run's Loop and Item, newest first, or `None` during a suppression. */
    readonly nextQueued: (
      runId: RunId,
    ) => Effect.Effect<Option.Option<QueuedEvents>, RunStoreError>;
    /**
     * Returns the queued Events of the Loop's Item, newest first, or `None` while the Item has an
     * open Run or a suppression.
     */
    readonly admissibleQueue: (
      loop: LoopName,
      itemKey: ItemKey,
    ) => Effect.Effect<Option.Option<QueuedEvents>, RunStoreError>;
    /** Moves a pending Run to `Waiting` and returns the Run's state. */
    readonly parkForApproval: (runId: RunId) => Effect.Effect<RunState.RunState, RunStoreError>;
    /**
     * The queues of the current cycle generation that no admission opened or revoked, each with
     * the newest closed Run of its Loop's Item. Excludes Items with an open Run, an open budget
     * ask, or a suppression.
     */
    readonly pendingQueues: Effect.Effect<ReadonlyArray<PendingQueue>, RunStoreError>;
    /** The open Runs that a fiber drives: pending, queued, or running, but not waiting for approval. */
    readonly runIdsToDrive: Effect.Effect<ReadonlyArray<RunId>, RunStoreError>;
    /**
     * Records a trigger Event as the Loop's sighting of the Item and claims it, with
     * `requestedRunId` as the new Run's ID. If the Item came back to the state of an Event whose
     * Run was canceled, records a reopening with its own Run ID (#267).
     */
    readonly recordAndClaim: (
      submission: Submission,
      requestedRunId: RunId,
    ) => Effect.Effect<Claim, RunStoreError>;
    /** Records what the executor kept of an Attempt's workspace, whatever the outcome. */
    readonly recordSalvage: (
      attemptId: AttemptId,
      salvage: AttemptSalvage,
    ) => Effect.Effect<void, RunStoreError>;
    /** Records the comments and reviews an unsuccessful Attempt posted on the Run's Item. */
    readonly recordComments: (
      attemptId: AttemptId,
      comments: ReadonlyArray<Comment>,
    ) => Effect.Effect<void, RunStoreError>;
    /**
     * Records the processes that the kernel killed in one of the Attempt's containers for memory.
     * The Attempt's `outOfMemory` adds up the kills of its containers; a second record of a
     * container replaces its count.
     */
    readonly recordOutOfMemory: (
      attemptId: AttemptId,
      kills: ContainerOutOfMemoryKills,
    ) => Effect.Effect<void, RunStoreError>;
    /**
     * Returns the Attempt's window and the overlapping windows of the same Agent's other Attempts
     * on the Item, oldest first (#429).
     */
    readonly attemptWindows: (attemptId: AttemptId) => Effect.Effect<AttemptWindows, RunStoreError>;
    /** The persisted Attempts that startup reconciliation visits, excluding discarded leftovers. */
    readonly salvageCandidates: Effect.Effect<ReadonlyArray<SalvageCandidate>, RunStoreError>;
    /** Returns `attemptId` as `salvageCandidates` lists it, or `None` once its leftovers are discarded. */
    readonly salvageCandidate: (
      attemptId: AttemptId,
    ) => Effect.Effect<Option.Option<SalvageCandidate>, RunStoreError>;
    /** Marks the Attempts on `worker` so reconciliation skips them, and returns the Attempts marked. */
    readonly discardLeftovers: (
      worker: WorkerName,
    ) => Effect.Effect<ReadonlyArray<AttemptId>, RunStoreError>;
    /**
     * Marks `attemptId`, a closed Attempt whose recovery found nothing left on its Worker, so
     * reconciliation skips it. Returns whether it marked the Attempt; an open or already discarded
     * Attempt stays as it is.
     */
    readonly discardClosedAttempt: (attemptId: AttemptId) => Effect.Effect<boolean, RunStoreError>;
    /** Returns the number of Attempts on `worker` without an outcome, excluding discarded leftovers. */
    readonly openAttempts: (worker: WorkerName) => Effect.Effect<number, RunStoreError>;
    /**
     * Marks the current failed Attempt as resolved, rejecting stale requests. Returns whether this
     * lifted a suppression, so the Item's queued Events get their turn.
     */
    readonly resolveFailure: (
      runId: RunId,
      attemptId: AttemptId,
      operator: Option.Option<OperatorActor>,
    ) => Effect.Effect<boolean, RunStoreError>;
    /**
     * Reopens a failed Run for its next Attempt, or records that a Run waiting after a capacity
     * refusal or for `wait` starts its next Attempt now, and returns what changed. `wait` is the
     * capacity group that the engine lists the Run as waiting for without an Attempt, or `None`.
     * Fails with `RunRetryBlockedError` while another Run of the same Loop and Item is open.
     */
    readonly retry: (
      runId: RunId,
      request: RetryRequest,
      wait: Option.Option<CapacityWait>,
    ) => Effect.Effect<RetryOutcome, RunStoreError>;
    /**
     * Opens a new Run for the Item state of a succeeded or canceled Run as an operator Event
     * (#152). Fails with `RunOperationRejectedError` for a Run in another state, or with
     * `RunRetryBlockedError` while another Run of the same Loop and Item is open.
     */
    readonly runAgain: (
      runId: RunId,
      request: RunAgainRequest,
    ) => Effect.Effect<RunAgainResult, RunStoreError>;
    /** Records a non-matching sighting and revokes unstarted Runs and queued Events; open-PR scope preserves only CI fixes for its observed failing head. */
    readonly revoke: (
      loop: LoopName,
      itemKey: ItemKey,
      scope?: RevokeScope,
    ) => Effect.Effect<ReadonlyArray<RunId>, RunStoreError>;
    /** Revokes the Events in `queued` that are still unclaimed, keeping later arrivals, and returns the number revoked. */
    readonly revokeQueued: (queued: QueuedEvents) => Effect.Effect<number, RunStoreError>;
    readonly snapshot: (runId: RunId) => Effect.Effect<RunSnapshot, RunStoreError>;
    /** Returns the Submission that opened the Run, as its trigger Event recorded it. */
    readonly submission: (runId: RunId) => Effect.Effect<Submission, RunStoreError>;
    readonly transcript: (
      query: TranscriptQuery,
    ) => Effect.Effect<ReadonlyArray<TranscriptEntry>, RunStoreError>;
  }
>()("@usine/engine/store/store/RunStore") {
  static readonly layer = Layer.effect(RunStore, makeRunStore);
}
