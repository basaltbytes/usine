import { Event } from "@usine/core/event";
import { AttemptContext, AttemptId } from "@usine/core/attempt";
import { Intervention } from "@usine/core/attempt/channel";
import { ItemKey } from "@usine/core/item";
import { LoopName } from "@usine/core/loop";
import { RunId } from "@usine/core/run";
import { Context, Crypto, type Duration, Effect, Layer, Option, Result } from "effect";
import { RunDatabase } from "../database/database.ts";
import {
  AttemptCancellationError,
  RunInterventionRejectedError,
  type RunEngineError,
} from "./error.ts";
import type { RunSnapshot } from "../run-reader/model.ts";
import { runIdFor, type Submission, type SubmissionResult } from "./submission.ts";
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
import { AttemptAdmission } from "./admission.ts";
import { RunDriver } from "./run-driver.ts";

/**
 * How long the engine waits between reconciles after the one at startup, so an
 * open Run whose fiber stopped, as on a store failure that outlasted its
 * retries, is driven again without a restart. Provide another value to change it.
 */
export const ReconcileInterval = Context.Reference<Duration.Input>(
  "@usine/engine/ReconcileInterval",
  { defaultValue: () => "3 minutes" },
);

// Every operation that commits a Run transition also hands it to the Run's
// fiber. Both happen uninterruptibly, so a caller that goes away cannot leave a
// committed transition undriven until the next restart.
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
    // The superseded Run's fiber stops before the new Run's fiber starts, so
    // the Item never has two fibers reserving Workers at once.
    if (Option.isSome(claim.supersededRun)) {
      yield* driver.stop(claim.supersededRun.value);
    }
    if (Option.isSome(claim.openedRun)) {
      yield* driver.launch(claim.openedRun.value);
    }
    return claim.result;
  }, Effect.uninterruptible);

  const approve = Effect.fn("RunEngine.approve")(function* (runId: RunId, approval: Event) {
    if (yield* store.approve(runId, approval)) {
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
    amendment: Option.Option<AttemptContext> = Option.none(),
  ) {
    if (yield* store.retry(runId, amendment)) {
      yield* driver.resume(runId);
      return;
    }
    yield* Effect.logDebug("Retry changed nothing; the Run already waits for its next Attempt", {
      runId,
    });
  }, Effect.uninterruptible);

  const cancel = Effect.fn("RunEngine.cancel")(function* (runId: RunId) {
    // The closing transaction decides both facts at once: whether the run was
    // still open, and which attempt was in flight when it closed.
    const outcome = yield* store.cancel(runId);
    if (outcome._tag === "AlreadyClosed") {
      yield* Effect.logDebug("Cancel was a no-op; the run was already closed", { runId });
      return;
    }
    yield* Effect.logInfo("Run canceled", {
      runId,
      openAttempt: Option.getOrElse(outcome.openAttempt, () => "none"),
    });
    // The executor stops the Attempt before its fiber is interrupted: an
    // interrupted launch that was never stopped keeps its parent task live for
    // a reattachment that will not come.
    const handshake = Option.isSome(outcome.openAttempt)
      ? yield* stepExecutor.interrupt(outcome.openAttempt.value).pipe(Effect.result)
      : Result.succeed(undefined);
    yield* driver.stop(runId);
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
            message:
              error._tag === "RunawayFailure"
                ? "The Attempt reached its runaway limit"
                : error._tag === "ChildSessionBudgetFailure"
                  ? "The Attempt reached its child-session budget"
                  : error.message,
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

  // Startup reconciliation belongs in this memoized layer: a combinator such as
  // `Layer.tap` runs again for every service the engine is provided to.
  const recoverWorkspaces = Effect.fn("RunEngine.recoverWorkspaces")(function* () {
    // Before Run recovery can admit a retry, publish and durably record any
    // work left by its predecessor. Failed recovery keeps the checkout on disk.
    yield* Effect.forEach(
      yield* store.salvageCandidates,
      (attempt) =>
        stepExecutor
          .recover(attempt, (salvage) => store.recordSalvage(attempt.attemptId, salvage))
          .pipe(
            Effect.tapError((error) =>
              Effect.logError("Attempt salvage reconciliation failed; work retained", {
                attemptId: attempt.attemptId,
                worker: attempt.worker,
                message: String(error),
              }),
            ),
            Effect.ignore,
          ),
      { discard: true },
    );
  });

  yield* recoverWorkspaces();
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
    drain: admission.drain,
    inspect,
    intervene,
    reconcile: driver.reconcile,
    retry,
    resolveFailure: store.resolveFailure,
    revoke,
    submit,
    transcript,
  } as const;
});

/** Records Events and manages their Runs through approval, execution, retry, and cancellation. */
export class RunEngine extends Context.Service<
  RunEngine,
  {
    /** Stops admitting Attempts, including retries, and waits for admitted work to settle. Interrupting this wait keeps admission closed until restart. */
    readonly drain: () => Effect.Effect<void>;
    /** Records the operator's approval Event and opens the Run's gate; execution still waits for a Worker slot. */
    readonly approve: (runId: RunId, approval: Event) => Effect.Effect<void, RunEngineError>;
    /** Cancels an open Run and interrupts its active Attempt. An already closed Run is unchanged. */
    readonly cancel: (runId: RunId) => Effect.Effect<void, RunEngineError>;
    /** Reads the Run's current state, effective task and Agent, Step result, and Attempt history. */
    readonly inspect: (runId: RunId) => Effect.Effect<RunSnapshot, RunEngineError>;
    /** Addresses one current Attempt explicitly so an old drawer cannot steer its replacement. */
    readonly intervene: (
      runId: RunId,
      attemptId: AttemptId,
      intervention: Intervention,
    ) => Effect.Effect<void, RunEngineError>;
    /**
     * Starts a fiber for every open Run without one in this process, except Runs waiting for their
     * approval, and opens the queued Events no closed Run continued. Also runs when the engine starts,
     * then every `ReconcileInterval`.
     */
    readonly reconcile: () => Effect.Effect<void, RunEngineError>;
    /** Resolves the current failed Attempt's attention without changing its outcome or starting work. */
    readonly resolveFailure: (
      runId: RunId,
      attemptId: AttemptId,
    ) => Effect.Effect<void, RunEngineError>;
    /** Requests another Attempt for a failed Run using its existing Event and effective task and Agent. */
    readonly retry: (
      runId: RunId,
      amendment?: Option.Option<AttemptContext>,
    ) => Effect.Effect<void, RunEngineError>;
    /** Cancels unstarted Runs and discards queued Events for a Loop's Item when it stops matching; running Attempts continue. */
    readonly revoke: (
      loop: LoopName,
      itemKey: ItemKey,
    ) => Effect.Effect<ReadonlyArray<RunId>, RunEngineError>;
    /**
     * Records a matching Event and claims its Run, or queues it behind the Item's
     * running Attempt. Repeated Events are deduplicated; execution continues separately.
     */
    readonly submit: (submission: Submission) => Effect.Effect<SubmissionResult, RunEngineError>;
    /** Reads the requested portion of an Attempt's persisted transcript in append order. */
    readonly transcript: (
      query: TranscriptQuery,
    ) => Effect.Effect<ReadonlyArray<TranscriptEntry>, RunEngineError>;
  }
>()("@usine/engine/RunEngine") {}

/**
 * Provides Run execution and recovery on the supplied database, whose run
 * tables are the only durable state of the Run lifecycle. The deployment
 * supplies `Crypto`, which hashes dedup keys into Run ids, the Worker
 * implementation through `StepExecutor`, and the trigger re-check for queued
 * Events through `TriggerCondition`.
 */
export const layerWithDatabase = <DatabaseError, DatabaseRequirements>(
  database: Layer.Layer<RunDatabase, DatabaseError, DatabaseRequirements>,
): Layer.Layer<
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
  const driver = RunDriver.layer.pipe(
    Layer.provideMerge(store),
    Layer.provideMerge(AttemptAdmission.layer),
  );
  const runEngine = Layer.effect(RunEngine, makeRunEngine).pipe(Layer.provide(driver));
  return Layer.mergeAll(
    runEngine,
    CycleBudgets.layer.pipe(Layer.provide(database)),
    RunReader.layer.pipe(Layer.provide(database)),
    CursorStore.layer.pipe(Layer.provide(database)),
    ItemProjectionReader.layer.pipe(Layer.provide(database)),
    ItemProjectionWriter.layer.pipe(Layer.provide(database)),
    RepositoryLabelProjectionReader.layer.pipe(Layer.provide(database)),
    RepositoryLabelProjectionWriter.layer.pipe(Layer.provide(database)),
    LoopControl.layer.pipe(Layer.provide(database)),
  );
};

export {
  Submission,
  Claimed,
  Queued,
  Ignored,
  CycleBlocked,
  IgnoreReason,
  SubmissionResult,
} from "./submission.ts";
export { RunEngineShutdown } from "./shutdown.ts";
export {
  RunNotFoundError,
  RunOperationRejectedError,
  RunRetryBlockedError,
  EnginePersistenceError,
  AttemptCancellationError,
  RunInterventionRejectedError,
  RunStoreError,
  RunEngineError,
} from "./error.ts";
