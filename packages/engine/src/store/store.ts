import { TranscriptCodec } from "./transcript/codec.ts";
import { InstanceScope } from "@usine/core/access";
import type { PoolRateLimitsUpdated } from "@usine/core/agent/session";
import { latestPoolRateLimits } from "../run-reader/pool-rate-limits.ts";
import { ChangeBus } from "@usine/core/changes";
import { changeTransaction } from "./changes.ts";
import { AttemptCanceled } from "@usine/core/attempt/outcome";
import type { CiResolution } from "@usine/core/ci";
import type { CommitSha } from "@usine/core/repository";
import { ciQueries } from "./ci.ts";
import { ActingMember } from "@usine/core/operator";
import {
  Attempt,
  AttemptId,
  FailureResolution,
  type AttemptWindows,
  type ContainerOutOfMemoryKills,
} from "@usine/core/attempt";
import * as AttemptChannel from "@usine/core/attempt/channel";
import { AttemptFailure, InfraFailure } from "@usine/core/attempt/failure";
import type { AttemptRecovery, AttemptSalvage } from "@usine/core/attempt/salvage";
import { StartedByEditAndRetry, StartedByRetry } from "@usine/core/attempt/start";
import { Event, EventId } from "@usine/core/event";
import { ItemKey } from "@usine/core/item";
import { LoopName } from "@usine/core/loop";
import { CycleGeneration } from "@usine/core/cycle-budget";
import type { OperatorActor } from "@usine/core/operator";
import { RunId, Run } from "@usine/core/run";
import { RunAgain } from "@usine/core/run/again";
import { ApprovalSource } from "@usine/core/run/approval";
import { WorkerName } from "@usine/core/worker";
import * as RunState from "@usine/core/run/state";
import { type Comment, StepResult } from "@usine/core/step/result";
import {
  type Brand,
  Array as EffectArray,
  Context,
  Crypto,
  DateTime,
  Duration,
  Effect,
  FiberMap,
  Layer,
  Match,
  Option,
  Result,
  Schema,
} from "effect";
import { ReadSnapshot, RunDatabase } from "../database/database.ts";
import {
  Claimed,
  CycleBlocked,
  Ignored,
  Queued,
  reopeningOf,
  runIdFor,
  Submission,
  SubmissionResult,
  Suppressed,
} from "../engine/submission.ts";
import {
  EnginePersistenceError,
  RunNotFoundError,
  RunOperationRejectedError,
  RunRetryBlockedError,
  type RunStoreError,
} from "../engine/error.ts";
import { RunSnapshot } from "../run-reader/model.ts";
import {
  type RunAgainRequest,
  type RunAgainResult,
  runAgainSubmission,
} from "../engine/run-again.ts";
import { plainRetry, type RetryRequest } from "../engine/retry.ts";
import { StepExecution } from "../step-executor.ts";
import { TranscriptEntry, TranscriptQuery } from "../transcript.ts";
import { attemptWindowQueries } from "./attempt-windows.ts";
import { leftoverQueries } from "./leftovers.ts";
import { persistence, submissionFromRow } from "./codec.ts";
import { queriesFor, type QueuedEvents } from "./queries.ts";
import {
  beginAttempt as decideBeginAttempt,
  cameBack,
  cancelRun,
  claimRun,
  finishAttempt as decideFinishAttempt,
  operatorStop,
  type OperatorStop,
  resightEvent,
  retryRun,
  suppressionDecision,
  type FinishDecision,
  type Settlement,
} from "../engine/lifecycle.ts";

const OptionalRunId = Schema.Option(RunId).pipe(
  Schema.withConstructorDefault(Effect.succeed(Option.none<RunId>())),
);

/** The result of recording an Event, with the Run it opened and the unstarted Run it superseded. */
export class Claim extends Schema.Class<Claim, Brand.Brand<"@usine/engine/store/store/Claim">>(
  "@usine/engine/internal/Claim",
)({
  result: SubmissionResult,
  /** The Run that this claim opened, not yet driven; `None` for a joined Run. */
  openedRun: OptionalRunId,
  supersededRun: OptionalRunId,
}) {}

/** A persisted Attempt that startup reconciliation visits, with its Run and the Run's Loop and Item. */
export interface SalvageCandidate extends AttemptRecovery {
  readonly runId: RunId;
  readonly loop: LoopName;
  readonly itemKey: ItemKey;
}

export class AttemptStarted extends Schema.TaggedClass<
  AttemptStarted,
  Brand.Brand<"@usine/engine/store/store/AttemptStarted">
>("@usine/engine/internal/AttemptStarted")("AttemptStarted", {
  execution: StepExecution,
}) {}

/** A Run that failed because failing the interrupted Attempt used its last automatic retry. */
export class AttemptRecoveryFailed extends Schema.TaggedClass<
  AttemptRecoveryFailed,
  Brand.Brand<"@usine/engine/store/store/AttemptRecoveryFailed">
>("@usine/engine/internal/AttemptRecoveryFailed")("AttemptRecoveryFailed", {}) {}

/** A Run that closed (canceled, superseded, or revoked) while waiting for a Worker slot; not an error. */
export class RunClosed extends Schema.TaggedClass<
  RunClosed,
  Brand.Brand<"@usine/engine/store/store/RunClosed">
>("@usine/engine/internal/RunClosed")("RunClosed", {}) {}

/** The result of `RunStore.cancel`, decided in the closing transaction, with the Run's Loop and Item. */
export type CancelOutcome =
  | { readonly _tag: "AlreadyClosed" }
  | {
      readonly _tag: "Canceled";
      readonly openAttempt: Option.Option<Pick<Attempt, "id" | "worker">>;
      readonly loop: LoopName;
      readonly itemKey: ItemKey;
    };

const makeRunStore = Effect.gen(function* () {
  const database = yield* RunDatabase;
  const readSnapshot = yield* ReadSnapshot;
  const bus = yield* ChangeBus;
  const poolResets = yield* FiberMap.make<string>();
  const transact = changeTransaction(database, bus);
  const crypto = yield* Crypto.Crypto;
  const codec = yield* TranscriptCodec;
  const queries = queriesFor(database, codec);

  const schedulePoolResets = Effect.fn("RunStore.schedulePoolResets")(function* (
    event: PoolRateLimitsUpdated,
  ) {
    yield* Effect.annotateCurrentSpan({ pool: event.pool });
    for (const window of ["primary", "secondary"] as const) {
      const key = `${event.pool}:${window}`;
      const limit = event.rateLimits[window];
      if (event.pool === "claudePlan" && Option.isNone(limit)) {
        yield* Effect.logDebug("Claude window unreported; keeping its pool reset deadline", {
          pool: event.pool,
          window,
        });
        continue;
      }
      yield* FiberMap.remove(poolResets, key);
      if (Option.isNone(limit) || Option.isNone(limit.value.resetsAt)) {
        yield* Effect.logDebug("Pool reset has no deadline", { pool: event.pool, window });
        continue;
      }
      const resetsAt = limit.value.resetsAt.value;
      const observedAt = yield* DateTime.now;
      const delay = Duration.toMillis(DateTime.distance(observedAt, resetsAt));
      if (delay <= 0) {
        yield* Effect.logDebug("Pool reset deadline has passed", { pool: event.pool, window });
        continue;
      }
      yield* Effect.logDebug("Scheduled pool reset notification", {
        pool: event.pool,
        window,
        resetsAt,
      });
      yield* FiberMap.run(
        poolResets,
        key,
        Effect.sleep(delay).pipe(
          Effect.andThen(
            Effect.logInfo("Pool reset deadline reached", { pool: event.pool, window }),
          ),
          Effect.andThen(
            bus.publish([
              { audience: InstanceScope.make(), target: { kind: "attention", id: "instance" } },
            ]),
          ),
        ),
      );
    }
  });
  for (const event of yield* latestPoolRateLimits(database)) yield* schedulePoolResets(event);

  /** Opens the Submission's Run as `runId` unless the Item's cycle budget is used up. */
  const admitRun = Effect.fn("RunStore.admitRun")(function* (
    tx: ReturnType<typeof queriesFor>,
    submission: Submission,
    runId: RunId,
  ) {
    const blocked = yield* tx.cycles.admit(submission);
    if (Option.isSome(blocked))
      return CycleBlocked.make({ eventId: submission.event.id, ask: blocked.value });
    yield* tx.createRun(submission, submission.event.id, runId);
    yield* tx.cycles.reserve(submission, runId);
    return Claimed.make({ eventId: submission.event.id, runId });
  });

  const openRun = Effect.fn("RunStore.openRun")(function* (
    tx: ReturnType<typeof queriesFor>,
    submission: Submission,
    runId: RunId,
    supersededRun: Option.Option<RunId> = Option.none(),
  ) {
    const result = yield* admitRun(tx, submission, runId);
    return Claim.make({
      result,
      openedRun: result._tag === "Claimed" ? Option.some(runId) : Option.none(),
      supersededRun,
    });
  });

  const runIdOf = (submission: Submission) =>
    runIdFor(submission).pipe(Effect.provideService(Crypto.Crypto, crypto));

  /** Returns the Event's Run or ignore reason, or `None` if the Event isn't claimed yet. */
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

  /**
   * Claims a recorded Event that has no Run and wasn't ignored: keeps it waiting during a
   * suppression, queues it, or opens its Run as `runId`.
   */
  const claimEvent = Effect.fn("RunStore.claimEvent")(function* (
    tx: ReturnType<typeof queriesFor>,
    recorded: Submission,
    runId: RunId,
  ) {
    if (!(yield* tx.cycles.isCurrentEvent(recorded))) {
      return Claim.make({
        result: Ignored.make({ eventId: recorded.event.id, reason: "superseded" }),
      });
    }
    const suppression = yield* tx.loopItems.suppression(recorded.loop, recorded.itemKey);
    if (Option.isSome(suppression)) {
      const decision = suppressionDecision(suppression.value, recorded.event.id);
      const fields = {
        eventId: recorded.event.id,
        suppressedBy: suppression.value.runId,
        loop: recorded.loop,
        itemKey: recorded.itemKey,
      };
      switch (decision._tag) {
        case "SuppressFrom":
          yield* tx.loopItems.suppressFrom(recorded.loop, recorded.itemKey, recorded.event.id);
          yield* Effect.logInfo(
            "First Item state after the Agent stopped for the operator; it waits for the operator",
            fields,
          );
          return Claim.make({
            result: Suppressed.make({ eventId: recorded.event.id, runId: suppression.value.runId }),
          });
        case "Suppress":
          yield* Effect.logInfo(
            "Item unchanged since the Agent stopped for the operator; no Run opens",
            fields,
          );
          return Claim.make({
            result: Suppressed.make({ eventId: recorded.event.id, runId: suppression.value.runId }),
          });
        case "Lift":
          yield* tx.loopItems.lift(recorded.loop, recorded.itemKey);
          yield* Effect.logInfo(
            "Item changed after the Agent stopped for the operator; the Loop acts on its new state",
            fields,
          );
      }
    }
    const blocking = yield* tx.blockingRun(recorded.loop, recorded.itemKey);
    const blockedBy = blocking[0];
    const decision = claimRun(
      blockedBy === undefined
        ? Option.none()
        : Option.some((yield* tx.snapshot(blockedBy.runId)).run),
      recorded.event.id,
      recorded.ciFailureHead,
    );
    yield* Effect.logInfo("Event claim decided", {
      eventId: recorded.event.id,
      decision: decision._tag,
    });
    switch (decision._tag) {
      case "QueueEvent":
        return Claim.make({ result: Queued.make({ eventId: recorded.event.id }) });
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
    return yield* transact((transaction, record) =>
      Effect.gen(function* () {
        const tx = queriesFor(transaction, codec, record);
        const recorded = yield* tx.recordTriggerEvent(submission);
        const previous = yield* tx.loopItems.sighted(
          recorded.loop,
          recorded.itemKey,
          recorded.event.id,
        );
        // After a reopening, later sightings of the trigger's Event join the newest reopening.
        const newestReopening = yield* tx.newestReopening(recorded.event.id);
        const current = Option.getOrElse(newestReopening, () => ({
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
            return Claim.make({ result: Claimed.make({ eventId, runId: decision.run.id }) });
          case "StayIgnored":
            yield* Effect.logInfo("Event remains ignored", { eventId, reason: decision.reason });
            return Claim.make({ result: Ignored.make({ eventId, reason: decision.reason }) });
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
            const admittedRunId = yield* runIdOf(reopened);
            return yield* claimEvent(tx, reopened, admittedRunId);
          }
        }
      }),
    );
  }, persistence("submit event"));

  const parkForApproval = Effect.fn("RunStore.parkForApproval")(function* (runId: RunId) {
    yield* Effect.annotateCurrentSpan({ runId });
    return yield* transact((transaction, record) =>
      Effect.gen(function* () {
        const tx = queriesFor(transaction, codec, record);
        const current = yield* tx.snapshot(runId);
        if (current.run.state._tag !== "Pending") return current.run.state;
        const waiting = RunState.awaitApproval(current.run.state);
        yield* tx.updateState(runId, waiting);
        return waiting;
      }),
    );
  }, persistence("park run for approval"));

  // Runs in the caller's transaction, so Attempt, Run, Step, and outbox writes commit or roll
  // back together (ADR 0010, ADR 0020).
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
        AwaitingCi: () => fields,
      }),
    );
    const endedAt = yield* DateTime.now;
    yield* tx.closeAttempt(attempt.id, outcome, endedAt);
    if (decision._tag === "RetryAttempt") return;
    if (decision._tag === "RunSucceeded" || decision._tag === "RunAwaitingCi") {
      yield* tx.updateStepResult(
        runId,
        attempt.stepName,
        StepResult.make({ ...decision.result, attemptId: Option.some(attempt.id) }),
      );
    }
    yield* tx.updateState(runId, decision.state, endedAt);
  });

  // The Event queued during the Attempt is usually the Agent's own question or blocker comment,
  // so it becomes the suppressed state.
  const suppressForOperator = Effect.fn("RunStore.suppressForOperator")(function* (
    tx: ReturnType<typeof queriesFor>,
    current: RunSnapshot,
    stop: OperatorStop,
  ) {
    const runId = current.run.id;
    const queuedRun = yield* tx.nextQueued(runId);
    const queued = Option.map(queuedRun, ({ submission }) => submission.event.id);
    const fields = { runId, loop: current.run.loop, itemKey: current.itemKey, stop };
    if (
      yield* tx.loopItems.startSuppression(
        current.run.loop,
        current.itemKey,
        runId,
        current.event.id,
        queued,
      )
    ) {
      yield* Effect.logInfo("Agent stopped for the operator; its Loop suppresses the Item", {
        ...fields,
        suppressedEventId: Option.getOrElse(queued, () => "none yet"),
      });
      return;
    }
    yield* Effect.logInfo(
      "Agent stopped for the operator, but nothing is suppressed; the Loop last saw the Item not matching",
      fields,
    );
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
    StepExecution.make({
      attempt,
      event: current.event,
      run: Run.make({
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
      permissions: current.permissions,
      resume,
      reattach,
    });

  const beginAttempt = Effect.fn("RunStore.beginAttempt")(function* (
    runId: RunId,
    worker: WorkerName,
    live: Option.Option<AttemptId>,
  ) {
    yield* Effect.annotateCurrentSpan({ runId, worker });
    return yield* transact((transaction, record) =>
      Effect.gen(function* () {
        const tx = queriesFor(transaction, codec, record);
        const current = yield* tx.snapshot(runId);
        const interruption = InfraFailure.make({
          message: "The orchestrator stopped during the attempt",
          cause: new Error("attempt interrupted by orchestrator restart"),
        });
        const requested = yield* tx.nextStart(runId);
        const decision = decideBeginAttempt(current, interruption, live, requested);
        if (decision._tag === "RunClosed") {
          yield* Effect.logInfo("Attempt start skipped", { runId, state: decision.state._tag });
          return RunClosed.make();
        }
        if (decision._tag === "RunFailed") {
          yield* applyFinish(tx, runId, decision);
          return AttemptRecoveryFailed.make();
        }
        if (decision._tag === "ReattachAttempt") {
          const reattachedAt = yield* DateTime.now;
          const attempt = Attempt.make({
            ...decision.attempt,
            reattachedAt: Option.some(reattachedAt),
          });
          yield* tx.recordReattach(attempt.id, reattachedAt);
          yield* Effect.annotateCurrentSpan({ attemptId: attempt.id });
          yield* Effect.logInfo("Attempt reattached after an orchestrator restart", {
            runId,
            attemptId: attempt.id,
            number: attempt.number,
            worker: attempt.worker,
          });
          if (attempt.worker !== worker) {
            // The Run reserves a slot on the Attempt's own Worker (#177), so a lease on another
            // Worker is a `StepExecutor` defect.
            yield* Effect.logError(
              "Reattached Attempt keeps its own Worker, not the reserved one",
              {
                runId,
                attemptId: attempt.id,
                worker: attempt.worker,
                reservedWorker: worker,
              },
            );
          }
          return AttemptStarted.make({
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
        const attempt = Attempt.make({
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
          endedAt: Option.none(),
          salvage: Option.none(),
          start: Option.some(decision.start),
          reattachedAt: Option.none(),
        });
        yield* tx.addAttempt(attempt);
        if (Option.isSome(requested)) yield* tx.setNextStart(runId, Option.none());
        yield* Effect.logInfo("Attempt started", {
          runId,
          attemptId,
          number: decision.number,
          worker,
          start: decision.start._tag,
          resumesFrom: Option.map(decision.resume, ({ ref }) => ref),
        });
        return AttemptStarted.make({
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
    yield* transact((transaction, record) =>
      queriesFor(transaction, codec, record).recordSalvage(attemptId, salvage),
    );
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
    yield* transact((transaction, record) =>
      queriesFor(transaction, codec, record).recordComments(attemptId, comments),
    );
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
    const attempt = yield* transact((transaction, record) =>
      queriesFor(transaction, codec, record).recordOutOfMemory(attemptId, kills),
    );
    yield* Effect.logInfo("Recorded the processes the kernel killed in the Attempt's container", {
      attemptId,
      container: kills.container,
      kills: kills.kills,
      memoryMib: kills.memoryMib,
      attemptKills: attempt.kills,
    });
  }, persistence("record attempt out-of-memory kills"));

  const attemptWindows = Effect.fn("RunStore.attemptWindows")(function* (attemptId: AttemptId) {
    yield* Effect.annotateCurrentSpan({ attemptId });
    const windows = yield* attemptWindowQueries(database).attemptWindows(attemptId);
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

  const openAttempts = Effect.fn("RunStore.openAttempts")(function* (worker: WorkerName) {
    yield* Effect.annotateCurrentSpan({ worker });
    return yield* leftoverQueries(database).openAttempts(worker);
  }, persistence("count open attempts"));

  const finishAttempt = Effect.fn("RunStore.finishAttempt")(function* (
    attempt: Attempt,
    result: Result.Result<StepResult, AttemptFailure>,
  ) {
    yield* Effect.annotateCurrentSpan({ runId: attempt.runId, attemptId: attempt.id });
    return yield* transact((transaction, record) =>
      Effect.gen(function* () {
        const tx = queriesFor(transaction, codec, record);
        const current = yield* tx.snapshot(attempt.runId);
        const [route] = yield* tx.eventRouteByRun(attempt.runId);
        if (route === undefined) return yield* Effect.die("A run has no recorded event");
        const decision = decideFinishAttempt(
          current,
          attempt.id,
          result,
          current.ciPolicy,
          route.ciOnGreen,
        );
        yield* applyFinish(tx, attempt.runId, decision);
        const stop = operatorStop(decision, result);
        if (Option.isSome(stop)) yield* suppressForOperator(tx, current, stop.value);
        return decision;
      }),
    );
  }, persistence("finish attempt"));

  const resolveFailure = Effect.fn("RunStore.resolveFailure")(function* (
    runId: RunId,
    attemptId: AttemptId,
    operator: Option.Option<OperatorActor>,
  ) {
    yield* Effect.annotateCurrentSpan({ runId, attemptId });
    return yield* transact((transaction, record) =>
      Effect.gen(function* () {
        const tx = queriesFor(transaction, codec, record);
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
          return yield* RunOperationRejectedError.make({
            runId,
            operation: "resolveFailure",
            state: current.run.state._tag,
          });
        }
        if (Option.contains(current.resolvedFailureAttemptId, attemptId)) {
          yield* Effect.logInfo("Run failure already resolved", { runId, attemptId });
          return false;
        }

        const resolution = FailureResolution.make({ resolvedAt: yield* DateTime.now, operator });
        yield* tx.resolveFailure(runId, attemptId, resolution);
        const lifted = yield* tx.loopItems.liftRun(runId);
        yield* Effect.logInfo("Run failure resolved", {
          runId,
          attemptId,
          liftedSuppression: lifted,
          resolvedAt: DateTime.formatIso(resolution.resolvedAt),
          operator: Option.getOrNull(operator),
        });
        return lifted;
      }),
    );
  }, persistence("resolve run failure"));

  const approve = Effect.fn("RunStore.approve")(function* (
    runId: RunId,
    approval: Event,
    source: ApprovalSource,
  ) {
    yield* Effect.annotateCurrentSpan({ runId, eventId: approval.id, channel: source.channel });
    return yield* transact((transaction, record) =>
      Effect.gen(function* () {
        const tx = queriesFor(transaction, codec, record);
        if (yield* tx.approvalExists(runId)) return false;
        const current = yield* tx.snapshot(runId);
        if (current.run.state._tag !== "Waiting") {
          return yield* RunOperationRejectedError.make({
            runId,
            operation: "approve",
            state: current.run.state._tag,
          });
        }
        yield* tx.recordApproval(runId, approval, source);
        yield* tx.updateState(runId, RunState.approve(current.run.state));
        return true;
      }),
    );
  }, persistence("approve run"));

  const retry = Effect.fn("RunStore.retry")(function* (
    runId: RunId,
    request: RetryRequest = plainRetry,
  ) {
    const { amendment, requestedBy } = request;
    yield* Effect.annotateCurrentSpan({ runId });
    return yield* transact((transaction, record) =>
      Effect.gen(function* () {
        const tx = queriesFor(transaction, codec, record);
        const current = yield* tx.snapshot(runId);
        const decision = retryRun(current);
        yield* Effect.logInfo("Operator retry decided", {
          runId,
          state: current.run.state._tag,
          decision: decision._tag,
        });
        if (decision._tag === "Resume") {
          // A later Event can have opened another Run of this Loop on the Item; reopening this one
          // would run both.
          const blocking = (yield* tx.blockingRun(current.run.loop, current.itemKey))[0];
          if (blocking !== undefined) {
            yield* Effect.logInfo("Operator retry rejected; another Run is open on the Item", {
              runId,
              openRunId: blocking.runId,
              loop: current.run.loop,
              itemKey: current.itemKey,
            });
            return yield* RunRetryBlockedError.make({
              runId,
              openRunId: blocking.runId,
              message: `Cannot retry run ${runId}: run ${blocking.runId} of loop "${current.run.loop}" is open on the same item. Cancel run ${blocking.runId}, or try again after it closes.`,
            });
          }
          // Preserve attribution for results stored before producing attempt IDs were recorded.
          if (
            Option.isSome(current.step.result) &&
            Option.isNone(current.step.result.value.attemptId)
          ) {
            const producer = EffectArray.findLast(
              current.attempts,
              ({ stepName }) => stepName === current.step.name,
            );
            if (Option.isSome(producer)) {
              yield* tx.updateStepResult(
                runId,
                current.step.name,
                StepResult.make({
                  ...current.step.result.value,
                  attemptId: Option.some(producer.value.id),
                }),
              );
              yield* Effect.logInfo("Recorded producing attempt for a legacy step result", {
                runId,
                attemptId: producer.value.id,
              });
            }
          }
          if (Option.isSome(amendment)) {
            yield* tx.amend(runId, amendment.value);
            yield* Effect.logInfo("Run effective task and Agent amended", {
              runId,
              agent: amendment.value.agent.name,
            });
          }
          // A retry lifts the suppression, so Events queue behind the running Run again.
          if (yield* tx.loopItems.liftRun(runId)) {
            yield* Effect.logInfo("Operator retry lifts the suppression of the Item", { runId });
          }
          yield* tx.setNextStart(
            runId,
            Option.some(
              Option.isSome(amendment)
                ? StartedByEditAndRetry.make({ operator: requestedBy })
                : StartedByRetry.make({ operator: requestedBy }),
            ),
          );
          yield* tx.updateState(runId, decision.state);
          return true;
        }
        if (decision._tag === "ResumePending" && Option.isNone(amendment)) return false;
        return yield* RunOperationRejectedError.make({
          runId,
          operation: "retry",
          state: current.run.state._tag,
        });
      }),
    );
  }, persistence("retry run"));

  const runAgain = Effect.fn("RunStore.runAgain")(function* (
    runId: RunId,
    request: RunAgainRequest,
  ) {
    yield* Effect.annotateCurrentSpan({ runId, agent: request.context.agent.name });
    const receivedAt = yield* DateTime.now;
    return yield* transact((transaction, record) =>
      Effect.gen(function* () {
        const tx = queriesFor(transaction, codec, record);
        const current = yield* tx.snapshot(runId);
        const { loop } = current.run;
        const { itemKey } = current;
        if (!RunState.operatorActions(current.run.state).canRunAgain) {
          yield* Effect.logInfo("Run again rejected; only a succeeded or canceled Run runs again", {
            runId,
            state: current.run.state._tag,
          });
          return yield* RunOperationRejectedError.make({
            runId,
            operation: "runAgain",
            state: current.run.state._tag,
          });
        }
        const blocking = (yield* tx.blockingRun(loop, itemKey))[0];
        if (blocking !== undefined) {
          yield* Effect.logInfo("Run again rejected; another Run is open on the Item", {
            runId,
            openRunId: blocking.runId,
            loop,
            itemKey,
          });
          return yield* RunRetryBlockedError.make({
            runId,
            openRunId: blocking.runId,
            message: `Run ${runId} cannot run again: run ${blocking.runId} of loop "${loop}" is open on the same item. Cancel run ${blocking.runId}, or try again after it closes.`,
          });
        }
        const reopenedEvent = yield* tx.reopenedEvent(current.event.id);
        const trigger = Option.getOrElse(reopenedEvent, () => ({
          eventId: current.event.id,
          dedupKey: current.event.dedupKey,
        }));
        const newestReopening = yield* tx.newestReopening(trigger.eventId);
        const reopening = Option.match(newestReopening, {
          onNone: () => 1,
          onSome: (newest) => newest.reopening + 1,
        });
        const cycleBudget = yield* tx.cycles.get(itemKey);
        const generation = Option.match(cycleBudget, {
          onNone: () => CycleGeneration.make(0),
          onSome: (budget) => budget.generation,
        });
        const again = runAgainSubmission(current, request, {
          trigger: trigger.dedupKey,
          reopening,
          generation,
          receivedAt,
        });
        // Not recorded as a sighting, so a later poll of the unchanged Item finds the new Run
        // through the reopening.
        const recorded = yield* tx.recordTriggerEvent(
          again,
          Option.some({ eventId: trigger.eventId, reopening }),
        );
        yield* tx.recordRunAgain(
          recorded.event.id,
          RunAgain.make({ from: runId, requestedBy: request.requestedBy }),
        );
        const admittedRunId = yield* runIdOf(recorded);
        const result = yield* admitRun(tx, recorded, admittedRunId);
        yield* Effect.logInfo(
          "Run again decided",
          Match.valueTags(result, {
            Claimed: ({ runId: openedRunId }) => ({
              runId,
              eventId: recorded.event.id,
              reopening,
              decision: "OpenRun",
              openedRunId,
              requestedBy: Option.getOrElse(request.requestedBy, () => "none"),
            }),
            CycleBlocked: ({ ask }) => ({
              runId,
              eventId: recorded.event.id,
              reopening,
              decision: "CycleBlocked",
              askId: ask.id,
              requestedBy: Option.getOrElse(request.requestedBy, () => "none"),
            }),
          }),
        );
        return result;
      }),
    );
  }, persistence("run again"));

  const cancel = Effect.fn("RunStore.cancel")(function* (runId: RunId) {
    yield* Effect.annotateCurrentSpan({ runId });
    return yield* transact((transaction, record) =>
      Effect.gen(function* () {
        const tx = queriesFor(transaction, codec, record);
        const current = yield* tx.snapshot(runId);
        const actor = yield* ActingMember;
        const decision = cancelRun(current, actor);
        yield* Effect.logInfo("Operator cancellation decided", {
          runId,
          state: current.run.state._tag,
          decision: decision._tag,
        });
        if (decision._tag === "AlreadyClosed") return decision;
        if (decision._tag === "CancelRejected")
          return yield* RunOperationRejectedError.make({
            runId,
            operation: "cancel",
            state: current.run.state._tag,
          });
        const canceledAt = yield* DateTime.now;
        if (Option.isSome(decision.attempt)) {
          const { id, outcome } = decision.attempt.value;
          yield* tx.closeAttempt(id, outcome, canceledAt);
        }
        if (current.run.state._tag === "AwaitingCi")
          yield* tx.settleCiAttempt(runId, AttemptCanceled.make());
        yield* tx.updateState(runId, decision.state, canceledAt);
        const canceled: CancelOutcome = {
          _tag: "Canceled",
          openAttempt: Option.map(decision.attempt, ({ id, worker }) => ({ id, worker })),
          loop: current.run.loop,
          itemKey: current.itemKey,
        };
        return canceled;
      }),
    );
  }, persistence("cancel run"));

  const revoke = Effect.fn("RunStore.revoke")(function* (loop: LoopName, itemKey: ItemKey) {
    return yield* transact((transaction, record) =>
      Effect.gen(function* () {
        const tx = queriesFor(transaction, codec, record);
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
    // Not recorded as a sighting, because the trigger can still submit this Event from a fetch
    // made before the closing Run changed the Item.
    return yield* queries.revokeQueued(loop, itemKey, queued.eventIds);
  }, persistence("revoke queued events"));

  const claimQueued = Effect.fn("RunStore.claimQueued")(function* (
    submission: Submission,
    runId: RunId,
  ) {
    return yield* transact((transaction, record) =>
      Effect.gen(function* () {
        const tx = queriesFor(transaction, codec, record);
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
        const suppression = yield* tx.loopItems.suppression(submission.loop, submission.itemKey);
        if (Option.isSome(suppression)) {
          return Option.none<RunId>();
        }
        if (!(yield* tx.cycles.isCurrentEvent(submission))) return Option.none<RunId>();
        return (yield* openRun(tx, submission, runId)).openedRun;
      }),
    );
  }, persistence("claim queued event"));

  const appendTranscript = Effect.fn("RunStore.appendTranscript")(function* (
    direction: AttemptChannel.Direction,
    envelope: AttemptChannel.Envelope,
  ) {
    const receivedAt = yield* DateTime.now;
    const inserted = yield* transact((transaction, record) =>
      Effect.gen(function* () {
        const tx = queriesFor(transaction, codec, record);
        if (!(yield* tx.appendTranscript(direction, envelope, receivedAt))) {
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
      yield* schedulePoolResets(envelope.payload.event);
    }
  }, persistence("append attempt transcript"));

  const transcript = Effect.fn("RunStore.transcript")(function* (query: TranscriptQuery) {
    return yield* readSnapshot.run(database, queries.transcript(query));
  }, persistence("read attempt transcript"));

  return {
    ...ciQueries(database, bus, codec),
    approve,
    appendTranscript,
    beginAttempt,
    cancel,
    claimQueued,
    finishAttempt,
    nextQueued: (runId: RunId) => queries.nextQueued(runId).pipe(persistence("find queued event")),
    parkForApproval,
    pendingContinuations: queries
      .pendingContinuations()
      .pipe(persistence("list pending continuations")),
    runIdsToDrive: queries.runIdsToDrive().pipe(persistence("list the runs to drive")),
    recordAndClaim,
    salvageCandidates: queries.salvageCandidates().pipe(persistence("list salvage candidates")),
    salvageCandidate: (attemptId: AttemptId) =>
      queries.salvageCandidate(attemptId).pipe(persistence("read a salvage candidate")),
    recordSalvage,
    recordComments,
    recordOutOfMemory,
    attemptWindows,
    discardLeftovers,
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
    resolveFailure,
    retry,
    revoke,
    revokeQueued,
    runAgain,
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
     * Starts the Run's next Attempt on `worker`. If `live` is the open Attempt, reattaches it;
     * otherwise fails any open Attempt first.
     */
    readonly beginAttempt: (
      runId: RunId,
      worker: WorkerName,
      live: Option.Option<AttemptId>,
    ) => Effect.Effect<AttemptStarted | AttemptRecoveryFailed | RunClosed, RunStoreError>;
    readonly cancel: (runId: RunId) => Effect.Effect<CancelOutcome, RunStoreError>;
    /** Opens the queued Event's Run as `runId` if the Item has no open Run, or returns `None`. */
    readonly claimQueued: (
      submission: Submission,
      runId: RunId,
    ) => Effect.Effect<Option.Option<RunId>, RunStoreError>;
    /**
     * Records an executor result if `attempt` is still the Run's open Attempt, committing its
     * outcome, the Step result, and the Run state together. A question or blocker also starts the
     * Loop's suppression of the Item.
     */
    readonly finishAttempt: (
      attempt: Attempt,
      result: Result.Result<StepResult, AttemptFailure>,
    ) => Effect.Effect<FinishDecision, RunStoreError>;
    /** Returns the newest queued Event of the Run's Loop and Item, or `None` during a suppression. */
    readonly nextQueued: (
      runId: RunId,
    ) => Effect.Effect<Option.Option<QueuedEvents>, RunStoreError>;
    /** Moves a pending Run to `Waiting` and returns the Run's state. */
    readonly parkForApproval: (runId: RunId) => Effect.Effect<RunState.RunState, RunStoreError>;
    /**
     * The closed Runs whose Item still has a queued Event that no continuation opened or revoked,
     * excluding Items under a suppression.
     */
    readonly pendingContinuations: Effect.Effect<ReadonlyArray<RunId>, RunStoreError>;
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
     * on the Item, oldest first (ADR 0006, #429).
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
     * Reopens a failed Run for its next Attempt and returns whether this call reopened it. Fails
     * with `RunRetryBlockedError` while another Run of the same Loop and Item is open.
     */
    readonly retry: (runId: RunId, request?: RetryRequest) => Effect.Effect<boolean, RunStoreError>;
    /**
     * Opens a new Run for the Item state of a succeeded or canceled Run as an operator Event
     * (#152). Fails with `RunOperationRejectedError` for a Run in another state, or with
     * `RunRetryBlockedError` while another Run of the same Loop and Item is open.
     */
    readonly runAgain: (
      runId: RunId,
      request: RunAgainRequest,
    ) => Effect.Effect<RunAgainResult, RunStoreError>;
    /** Records a non-matching sighting and revokes the Loop's unstarted Runs and queued Events for the Item. */
    readonly revoke: (
      loop: LoopName,
      itemKey: ItemKey,
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
