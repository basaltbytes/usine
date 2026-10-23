import { Event } from "@usine/core/event";
import { AttemptId } from "@usine/core/attempt";
import { Intervention } from "@usine/core/attempt/channel";
import { ItemKey } from "@usine/core/item";
import { LoopName } from "@usine/core/loop";
import { RunId } from "@usine/core/run";
import { ApprovalSource } from "@usine/core/run/approval";
import type { WorkerName } from "@usine/core/worker";
import { Context, Crypto, type Duration, Effect, Layer, Match, Option, Result } from "effect";
import { RunDatabase } from "../database/database.ts";
import {
  AttemptCancellationError,
  LeftoversDiscardRejectedError,
  RunInterventionRejectedError,
  type RunEngineError,
} from "./error.ts";
import type { RunSnapshot } from "../run-reader/model.ts";
import { runIdFor, type Submission, type SubmissionResult } from "./submission.ts";
import type { RunAgainRequest, RunAgainResult } from "./run-again.ts";
import { plainRetry, type RetryRequest } from "./retry.ts";
import type { TranscriptEntry, TranscriptQuery } from "../transcript.ts";
import { RunStore } from "../store/store.ts";
import { RunReader } from "../run-reader/run-reader.ts";
import { ItemProjectionReader, ItemProjectionWriter } from "../item-projection/item-projection.ts";
import {
  RepositoryLabelProjectionReader,
  RepositoryLabelProjectionWriter,
} from "../repository-label-projection/repository-label-projection.ts";
import { StepExecutor } from "../step-executor.ts";
import { TriggerCondition } from "../trigger-condition.ts";
import { CursorStore } from "../cursor/cursor.ts";
import { LoopControl } from "../loop-control/loop-control.ts";
import { CycleBudgets } from "../cycle-budget/cycle-budget.ts";
import { BoardMoves } from "../board-moves/board-moves.ts";
import { AttemptAdmission } from "./admission.ts";
import { RunDriver } from "./run-driver.ts";

/** The interval between periodic reconciles, which restart open Runs whose fiber stopped. */
export const ReconcileInterval = Context.Reference<Duration.Input>(
  "@usine/engine/ReconcileInterval",
  { defaultValue: () => "3 minutes" },
);

// Operations that commit a Run transition also hand it to the Run's fiber, uninterruptibly, so an
// interrupted caller can't leave a committed transition undriven.
const makeRunEngine = Effect.gen(function* () {
  const store = yield* RunStore;
  const driver = yield* RunDriver;
  const admission = yield* AttemptAdmission;
  const stepExecutor = yield* StepExecutor;
  const crypto = yield* Crypto.Crypto;

  const submit = Effect.fn("RunEngine.submit")(function* (submission: Submission) {
    const requestedRunId = yield* runIdFor(submission).pipe(
      Effect.provideService(Crypto.Crypto, crypto),
    );
    const claim = yield* store.recordAndClaim(submission, requestedRunId);
    // Stop the superseded Run's fiber before starting the new one, so the Item never has two
    // fibers reserving Workers.
    if (Option.isSome(claim.supersededRun)) {
      yield* driver.stop(claim.supersededRun.value);
    }
    if (Option.isSome(claim.openedRun)) {
      yield* driver.launch(claim.openedRun.value);
    }
    return claim.result;
  }, Effect.uninterruptible);

  const approve = Effect.fn("RunEngine.approve")(function* (
    runId: RunId,
    approval: Event,
    source: ApprovalSource,
  ) {
    if (yield* store.approve(runId, approval, source)) {
      yield* Effect.logInfo("Run approved", {
        runId,
        eventId: approval.id,
        channel: source.channel,
        approver: Option.getOrElse(source.approver, () => "none"),
      });
      yield* driver.resume(runId);
      return;
    }
    yield* Effect.logDebug("Approval was already recorded; the Run is unchanged", {
      runId,
      eventId: approval.id,
    });
  }, Effect.uninterruptible);

  const retry = Effect.fn("RunEngine.retry")(function* (
    runId: RunId,
    request: RetryRequest = plainRetry,
  ) {
    if (yield* store.retry(runId, request)) {
      yield* driver.resume(runId);
      return;
    }
    yield* Effect.logDebug("Retry changed nothing; the Run already waits for its next Attempt", {
      runId,
    });
  }, Effect.uninterruptible);

  const runAgain = Effect.fn("RunEngine.runAgain")(function* (
    runId: RunId,
    request: RunAgainRequest,
  ) {
    const result = yield* store.runAgain(runId, request);
    if (result._tag === "Claimed") yield* driver.launch(result.runId);
    return result;
  }, Effect.uninterruptible);

  const cancel = Effect.fn("RunEngine.cancel")(function* (runId: RunId) {
    // One transaction determines whether the Run was open and which Attempt was running.
    const outcome = yield* store.cancel(runId);
    if (outcome._tag === "AlreadyClosed") {
      yield* Effect.logDebug("Cancel was a no-op; the run was already closed", { runId });
      return;
    }
    yield* Effect.logInfo("Run canceled", {
      runId,
      openAttempt: Option.getOrElse(outcome.openAttempt, () => "none"),
    });
    // Stop the Attempt before interrupting its fiber; otherwise its parent task stays live
    // waiting for a reattach.
    const handshake = Option.isSome(outcome.openAttempt)
      ? yield* stepExecutor.interrupt(outcome.openAttempt.value).pipe(Effect.result)
      : Result.succeed(undefined);
    yield* driver.stop(runId);
    // Release a checkout and slot that startup kept for a reattach; they stay kept until the
    // parent task is confirmed stopped.
    if (Option.isSome(outcome.openAttempt)) yield* driver.releaseKept(outcome.openAttempt.value);
    yield* driver.continueWithNewest(runId);
    if (Option.isSome(outcome.openAttempt) && Result.isFailure(handshake)) {
      return yield* new AttemptCancellationError({
        attemptId: outcome.openAttempt.value,
        cause: handshake.failure,
      });
    }
  }, Effect.uninterruptible);

  const intervene = Effect.fn("RunEngine.intervene")(function* (
    runId: RunId,
    attemptId: AttemptId,
    intervention: Intervention,
  ) {
    yield* Effect.annotateCurrentSpan({ runId, attemptId, action: intervention.action._tag });
    const current = yield* store.snapshot(runId);
    const active = current.attempts.at(-1);
    if (
      current.run.state._tag !== "Running" ||
      active?.id !== attemptId ||
      Option.isSome(active.outcome)
    ) {
      yield* Effect.logInfo("Operator input rejected for an inactive Attempt", {
        runId,
        attemptId,
      });
      return yield* new RunInterventionRejectedError({
        runId,
        attemptId,
        message: "This Attempt is no longer running",
      });
    }
    yield* stepExecutor.intervene(attemptId, intervention).pipe(
      Effect.mapError(
        (error) =>
          new RunInterventionRejectedError({
            runId,
            attemptId,
            message: Match.valueTags(error, {
              RunawayFailure: () => "The Attempt reached its runaway limit",
              ChildSessionBudgetFailure: () => "The Attempt reached its child-session budget",
              QuestionFailure: () => "The Attempt ended with a question for the operator",
              BlockedFailure: ({ message }) => message,
              InfraFailure: ({ message }) => message,
              DefectFailure: ({ message }) => message,
              AgentFailure: ({ message }) => message,
            }),
          }),
      ),
      Effect.tapError((error) =>
        Effect.logWarning("Operator input delivery failed", {
          runId,
          attemptId,
          message: error.message,
        }),
      ),
    );
  });

  const resolveFailure = Effect.fn("RunEngine.resolveFailure")(function* (
    runId: RunId,
    attemptId: AttemptId,
  ) {
    if (!(yield* store.resolveFailure(runId, attemptId))) return;
    yield* Effect.logInfo(
      "The operator resolved the Agent's question or blocker; the Item's queued Events get their turn",
      {
        runId,
        attemptId,
      },
    );
    yield* driver.continueWithNewest(runId);
  }, Effect.uninterruptible);

  const revoke = Effect.fn("RunEngine.revoke")(function* (loop: LoopName, itemKey: ItemKey) {
    const revoked = yield* store.revoke(loop, itemKey);
    yield* Effect.forEach(revoked, driver.stop, { concurrency: "unbounded", discard: true });
    return revoked;
  }, Effect.uninterruptible);

  const inspect = Effect.fn("RunEngine.inspect")(function* (runId: RunId) {
    return yield* store.snapshot(runId);
  });

  const transcript = Effect.fn("RunEngine.transcript")(function* (query: TranscriptQuery) {
    return yield* store.transcript(query);
  });

  const discardLeftovers = Effect.fn("RunEngine.discardLeftovers")(function* (worker: WorkerName) {
    yield* Effect.annotateCurrentSpan({ worker });
    if ((yield* stepExecutor.workers).includes(worker)) {
      const running = yield* store.openAttempts(worker);
      yield* Effect.logInfo(
        "Leftovers kept; the Worker is configured or still runs Attempts, so its Attempts stay tracked",
        { worker, running },
      );
      return yield* new LeftoversDiscardRejectedError({ worker, running });
    }
    const attempts = yield* store.discardLeftovers(worker);
    yield* Effect.logInfo(
      "Discarded the leftovers of the Attempts on a Worker that is not configured; startup no longer reconciles them",
      { worker, attempts },
    );
    return attempts;
  });

  // Startup reconciliation runs here because this layer is memoized; `Layer.tap` would run it
  // once per service the engine is provided to.
  yield* driver.recoverWorkspaces();
  yield* driver.reconcile();
  const interval = yield* ReconcileInterval;
  yield* Effect.sleep(interval).pipe(
    Effect.andThen(driver.reconcile()),
    Effect.tapError((error) =>
      Effect.logError("Periodic Run reconcile failed; the next one tries again", {
        errorTag: error._tag,
      }),
    ),
    Effect.ignore,
    Effect.forever,
    Effect.forkScoped,
  );

  return {
    approve,
    cancel,
    discardLeftovers,
    drain: admission.drain,
    inspect,
    intervene,
    reconcile: driver.reconcile,
    retry,
    resolveFailure,
    revoke,
    runAgain,
    submit,
    transcript,
  } as const;
});

/** The service that records Events and drives their Runs through approval, execution, retry, and cancellation. */
export class RunEngine extends Context.Service<
  RunEngine,
  {
    /** Stops admitting Attempts, including retries, and waits for admitted Attempts to finish. Admission stays closed until restart. */
    readonly drain: () => Effect.Effect<void>;
    /** Records the approval Event and its source, and opens the Run's approval gate. A repeated approval keeps the first source. */
    readonly approve: (
      runId: RunId,
      approval: Event,
      source: ApprovalSource,
    ) => Effect.Effect<void, RunEngineError>;
    /** Cancels an open Run and interrupts its active Attempt; does nothing for a closed Run. */
    readonly cancel: (runId: RunId) => Effect.Effect<void, RunEngineError>;
    /**
     * Stops reconciling the Attempts recorded on `worker`, leaving their files in place, and
     * returns the number of Attempts marked. Fails with `LeftoversDiscardRejectedError` if
     * `worker` is in `StepExecutor.workers`.
     */
    readonly discardLeftovers: (
      worker: WorkerName,
    ) => Effect.Effect<number, RunEngineError | LeftoversDiscardRejectedError>;
    /** Returns the Run's state, effective task and Agent, Step result, and Attempt history. */
    readonly inspect: (runId: RunId) => Effect.Effect<RunSnapshot, RunEngineError>;
    /** Sends operator input to `attemptId`. Fails with `RunInterventionRejectedError` if it isn't the Run's running Attempt. */
    readonly intervene: (
      runId: RunId,
      attemptId: AttemptId,
      intervention: Intervention,
    ) => Effect.Effect<void, RunEngineError>;
    /**
     * Starts a fiber for every open Run without one, except Runs waiting for approval, and opens the
     * queued Events that no closed Run continued. Runs at startup and every `ReconcileInterval`.
     */
    readonly reconcile: () => Effect.Effect<void, RunEngineError>;
    /**
     * Marks the current failed Attempt as resolved without changing its outcome. If the Attempt
     * stopped with a question or blocker, the Loop evaluates the Item's queued Events again.
     */
    readonly resolveFailure: (
      runId: RunId,
      attemptId: AttemptId,
    ) => Effect.Effect<void, RunEngineError>;
    /**
     * Requests another Attempt for a failed Run with its existing Event, applying the request's
     * task and Agent if set. The Attempt records the request as its start reason.
     */
    readonly retry: (runId: RunId, request?: RetryRequest) => Effect.Effect<void, RunEngineError>;
    /**
     * Opens a new Run for the Item state of a succeeded or canceled Run, with the request's task
     * and Agent, as an operator Event. The Item's cycle budget and the Loop's approval gate apply.
     */
    readonly runAgain: (
      runId: RunId,
      request: RunAgainRequest,
    ) => Effect.Effect<RunAgainResult, RunEngineError>;
    /** Cancels unstarted Runs and discards queued Events for a Loop's Item that stopped matching; running Attempts continue. */
    readonly revoke: (
      loop: LoopName,
      itemKey: ItemKey,
    ) => Effect.Effect<ReadonlyArray<RunId>, RunEngineError>;
    /**
     * Records a matching Event and claims its Run, or queues it behind the Item's running Attempt.
     * Deduplicates repeated Events.
     */
    readonly submit: (submission: Submission) => Effect.Effect<SubmissionResult, RunEngineError>;
    /** Returns the requested part of an Attempt's transcript, in append order. */
    readonly transcript: (
      query: TranscriptQuery,
    ) => Effect.Effect<ReadonlyArray<TranscriptEntry>, RunEngineError>;
  }
>()("@usine/engine/RunEngine") {}

/**
 * Returns the engine layers on `database`, which stores all durable Run state. Requires `Crypto`
 * for Run IDs, `StepExecutor` for Workers, and `TriggerCondition` to re-check queued Events.
 */
export const layerWithDatabase = <DatabaseError, DatabaseRequirements>(
  database: Layer.Layer<RunDatabase, DatabaseError, DatabaseRequirements>,
): Layer.Layer<
  | BoardMoves
  | CursorStore
  | CycleBudgets
  | ItemProjectionReader
  | ItemProjectionWriter
  | LoopControl
  | RepositoryLabelProjectionReader
  | RepositoryLabelProjectionWriter
  | RunEngine
  | RunReader,
  RunEngineError | DatabaseError,
  Crypto.Crypto | StepExecutor | TriggerCondition | DatabaseRequirements
> => {
  const store = RunStore.layer.pipe(Layer.provide(database));
  const itemWriter = ItemProjectionWriter.layer.pipe(Layer.provide(database));
  const driver = RunDriver.layer.pipe(
    Layer.provideMerge(store),
    Layer.provideMerge(AttemptAdmission.layer),
    Layer.provide(itemWriter),
  );
  const runEngine = Layer.effect(RunEngine, makeRunEngine).pipe(Layer.provide(driver));
  return Layer.mergeAll(
    runEngine,
    BoardMoves.layer.pipe(Layer.provide(database)),
    CycleBudgets.layer.pipe(Layer.provide(database)),
    RunReader.layer.pipe(Layer.provide(database)),
    CursorStore.layer.pipe(Layer.provide(database)),
    ItemProjectionReader.layer.pipe(Layer.provide(database)),
    itemWriter,
    RepositoryLabelProjectionReader.layer.pipe(Layer.provide(database)),
    RepositoryLabelProjectionWriter.layer.pipe(Layer.provide(database)),
    LoopControl.layer.pipe(Layer.provide(database)),
  );
};

export {
  Submission,
  Claimed,
  Queued,
  Suppressed,
  Ignored,
  CycleBlocked,
  IgnoreReason,
  SubmissionResult,
} from "./submission.ts";
export { RunAgainRequest, RunAgainResult } from "./run-again.ts";
export { RetryRequest } from "./retry.ts";
export { RunEngineShutdown } from "./shutdown.ts";
export {
  RunNotFoundError,
  RunOperationRejectedError,
  RunRetryBlockedError,
  EnginePersistenceError,
  AttemptCancellationError,
  RunInterventionRejectedError,
  LeftoversDiscardRejectedError,
  RunStoreError,
  RunEngineError,
} from "./error.ts";
