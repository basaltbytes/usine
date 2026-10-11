import type { AttemptId } from "@usine/core/attempt";
import { type AttemptFailure, DefectFailure, InfraFailure } from "@usine/core/attempt/failure";
import type { RunId } from "@usine/core/run";
import type { WorkerName } from "@usine/core/worker";
import { Cause, Context, Crypto, Effect, Fiber, FiberMap, Layer, Option, Result } from "effect";
import { StepExecutor } from "../step-executor.ts";
import { RunStore } from "../store/store.ts";
import { TriggerCondition } from "../trigger-condition.ts";
import { AttemptAdmission } from "./admission.ts";
import type {
  EnginePersistenceError,
  RunNotFoundError,
  RunOperationRejectedError,
  RunStoreError,
} from "./error.ts";
import type { FinishDecision } from "./lifecycle.ts";
import { runIdFor } from "./submission.ts";

// The executor's sinks speak AttemptFailure: a write the store could not make
// fails the Attempt as infrastructure, and a missing or rejected Run is a defect.
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

/**
 * Drives open Runs in this process, one fiber per Run, with usine's run
 * tables as the only durable state. A Run's fiber parks a gated Run for
 * approval, then reserves a Worker, opens or reattaches the Attempt, records
 * its outcome, and repeats until the Run closes. The fiber that closes its Run
 * then gives the newest queued Event of the Item its turn; when cancel,
 * supersede, or revoke closes the Run under its fiber, that operation takes
 * care of the queued Events instead. A fiber that ends without closing its Run
 * (approval, operator retry, this process stopping) leaves the Run for
 * `resume` or `reconcile`.
 */
export class RunDriver extends Context.Service<
  RunDriver,
  {
    /** Starts the fiber of an open Run. A Run whose fiber already runs here keeps it. */
    readonly launch: (runId: RunId) => Effect.Effect<void>;
    /** Starts the fiber of a Run an approval or an operator retry just reopened, after its previous fiber has ended. */
    readonly resume: (runId: RunId) => Effect.Effect<void>;
    /** Interrupts the fiber of a Run that just closed and waits for it to end. */
    readonly stop: (runId: RunId) => Effect.Effect<void>;
    /**
     * Gives the newest queued Event of the closed Run's Item its turn. The
     * trigger is re-evaluated against the Item's current state first, because
     * the queued Event may describe state the closed Run itself changed.
     */
    readonly continueWithNewest: (closedRunId: RunId) => Effect.Effect<void, RunStoreError>;
    /**
     * Recovers from the run tables: opens the queued Events whose continuation
     * did not run, and starts the fiber of every open Run. Runs whose fiber
     * already runs here are left alone.
     */
    readonly reconcile: () => Effect.Effect<void, RunStoreError>;
  }
>()("@usine/engine/internal/RunDriver") {
  static readonly layer = Layer.effect(
    RunDriver,
    Effect.gen(function* () {
      const store = yield* RunStore;
      const executor = yield* StepExecutor;
      const admission = yield* AttemptAdmission;
      const condition = yield* TriggerCondition;
      const crypto = yield* Crypto.Crypto;
      const fibers = yield* FiberMap.make<RunId>();

      // Annotated because a fiber's continuation calls launch again, which TypeScript cannot infer.
      const launch: RunDriver["Service"]["launch"] = Effect.fn("RunDriver.launch")(function* (
        runId: RunId,
      ) {
        yield* Effect.annotateCurrentSpan({ runId });
        if (yield* FiberMap.has(fibers, runId)) {
          yield* Effect.logDebug("The Run's fiber already runs in this process", { runId });
          return;
        }
        yield* Effect.logDebug("Starting the Run's fiber", { runId });
        yield* FiberMap.run(
          fibers,
          runId,
          drive(runId).pipe(
            Effect.catchCause((cause) =>
              Cause.hasInterruptsOnly(cause)
                ? Effect.failCause(cause)
                : Effect.logError(
                    "The Run's fiber stopped on an engine failure; RunEngine.reconcile or a restart resumes it",
                    { runId, cause },
                  ),
            ),
          ),
          { onlyIfMissing: true },
        );
      });

      const resume = Effect.fn("RunDriver.resume")(function* (runId: RunId) {
        yield* Effect.annotateCurrentSpan({ runId });
        const previous = yield* FiberMap.get(fibers, runId);
        if (Option.isSome(previous)) {
          // The fiber that parked or failed the Run ends right after its last
          // write; a new fiber must not start until that one has left the map.
          yield* Effect.logDebug("Waiting for the Run's previous fiber to end", { runId });
          yield* Fiber.await(previous.value);
        }
        yield* launch(runId);
      });

      const stop = Effect.fn("RunDriver.stop")(function* (runId: RunId) {
        yield* Effect.annotateCurrentSpan({ runId });
        if (!(yield* FiberMap.has(fibers, runId))) {
          yield* Effect.logDebug("The closed Run has no fiber in this process", { runId });
          return;
        }
        yield* FiberMap.remove(fibers, runId);
        yield* Effect.logInfo("The closed Run's fiber stopped", { runId });
      });

      const continueWithNewest = Effect.fn("RunDriver.continueWithNewest")(function* (
        closedRunId: RunId,
      ) {
        yield* Effect.annotateCurrentSpan({ runId: closedRunId });
        const queued = yield* store.nextQueued(closedRunId);
        if (Option.isNone(queued)) return;
        const submission = queued.value.submission;
        const fields = {
          completedRunId: closedRunId,
          eventId: submission.event.id,
          loop: submission.loop,
          itemKey: submission.itemKey,
        };
        if (!(yield* condition.holds(submission))) {
          // Only the queue observed before the remote check belongs to this result.
          const revoked = yield* store.revokeQueued(queued.value);
          yield* Effect.logInfo("Queued Event no longer matches its trigger; revoked", {
            ...fields,
            revokedEvents: revoked,
          });
          return;
        }
        const runId = yield* runIdFor(submission).pipe(
          Effect.provideService(Crypto.Crypto, crypto),
        );
        const claimed = yield* store.claimQueued(submission, runId);
        if (Option.isNone(claimed)) {
          // The Item moved on during the check: the Event was ignored, another
          // Run opened for the Item, or a cycle reset superseded the Event.
          yield* Effect.logInfo(
            "Queued Event still matches its trigger but could no longer be claimed; no Run opened",
            fields,
          );
          return;
        }
        yield* Effect.logInfo("Queued Event still matches its trigger; opening its Run", {
          ...fields,
          runId: claimed.value,
        });
        yield* launch(claimed.value);
      });

      /**
       * The Run's open Attempt when its parent task outlived an orchestrator restart.
       * A liveness read that fails is logged and treated as not live, so the Run
       * moves on to a new Attempt as it did before reattachment existed.
       */
      const liveAttempt = Effect.fn("RunDriver.liveAttempt")(function* (runId: RunId) {
        yield* Effect.annotateCurrentSpan({ runId });
        const current = yield* store.snapshot(runId);
        const open = current.attempts.at(-1);
        if (
          current.run.state._tag !== "Running" ||
          open === undefined ||
          Option.isSome(open.outcome)
        )
          return Option.none<AttemptId>();
        yield* Effect.annotateCurrentSpan({ attemptId: open.id, worker: open.worker });
        const live = yield* executor.isLive(open.id).pipe(Effect.result);
        if (Result.isFailure(live)) {
          yield* Effect.logWarning(
            "Could not read whether the open Attempt is live; opening the next one",
            {
              runId,
              attemptId: open.id,
              worker: open.worker,
              errorTag: live.failure._tag,
              message: live.failure.message,
            },
          );
          return Option.none<AttemptId>();
        }
        yield* Effect.logInfo(
          live.success
            ? "The open Attempt's parent task is live; reattaching it"
            : "The open Attempt's parent task is gone; opening the next Attempt",
          { runId, attemptId: open.id, worker: open.worker },
        );
        return live.success ? Option.some(open.id) : Option.none<AttemptId>();
      });

      /** Runs one Attempt on the reserved Worker and returns what it did to the Run. */
      const executeAttempt = Effect.fn("RunDriver.attempt")(function* (
        runId: RunId,
        worker: WorkerName,
      ) {
        yield* Effect.annotateCurrentSpan({ runId, worker });
        const started = yield* store.beginAttempt(runId, worker, yield* liveAttempt(runId));
        if (started._tag === "AttemptRecoveryFailed") return "RunFailed";
        if (started._tag === "RunClosed") return "Unchanged";

        // Preserve an executor defect as a terminal Attempt outcome without
        // turning a programming bug into an automatic retry (ADR 0003).
        const result = yield* executor
          .execute(started.execution, {
            append: (direction, envelope) =>
              store.appendTranscript(direction, envelope).pipe(asAttemptFailure),
            salvage: (salvage) =>
              store.recordSalvage(started.execution.attempt.id, salvage).pipe(asAttemptFailure),
          })
          .pipe(
            Effect.catchDefect((defect) =>
              Effect.logError("Step executor defect; operator intervention required", {
                runId,
                attemptId: started.execution.attempt.id,
                defect: defect instanceof Error ? defect.message : String(defect),
              }).pipe(
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
        return (yield* store.finishAttempt(started.execution.attempt, result))._tag;
      });

      const drive = Effect.fn("RunDriver.drive")(function* (runId: RunId) {
        const submission = yield* store.submission(runId);
        yield* Effect.annotateCurrentSpan({
          runId,
          loop: submission.loop,
          itemKey: submission.itemKey,
        });
        if (
          submission.approval === "required" &&
          (yield* store.parkForApproval(runId))._tag === "Waiting"
        ) {
          yield* Effect.logInfo("Run waits for its approval", { runId });
          return;
        }

        let outcome: FinishDecision["_tag"];
        do {
          // The wait for a worker slot stays interruptible so a cancel can reach a run
          // parked in `reserve`; the scheduler releases or reoffers the slot in its own
          // onInterrupt. The release obligation begins only once the lease exists.
          outcome = yield* Effect.uninterruptibleMask((restore) =>
            restore(executor.reserve(submission)).pipe(
              Effect.flatMap((lease) =>
                restore(admission.withAttempt(runId, executeAttempt(runId, lease.worker))).pipe(
                  Effect.ensuring(lease.release),
                ),
              ),
            ),
          );
        } while (outcome === "RetryAttempt");

        // Cancel, supersede, and revoke close a Run under its fiber and take care
        // of the Item's queued Events themselves; their stop may interrupt this
        // fiber anywhere, including between claiming an Event and starting its Run.
        if (outcome === "Unchanged") {
          yield* Effect.logInfo("Run closed by another operation; its fiber ends", { runId });
          return;
        }
        yield* continueWithNewest(runId);
      });

      const reconcile = Effect.fn("RunDriver.reconcile")(function* () {
        const continuations = yield* store.pendingContinuations;
        yield* Effect.forEach(
          continuations,
          (runId) =>
            continueWithNewest(runId).pipe(
              Effect.tapError((error) =>
                Effect.logError("Could not continue the queued Events behind a closed Run", {
                  runId,
                  errorTag: error._tag,
                }),
              ),
              Effect.ignore,
            ),
          { discard: true },
        );
        const open = yield* store.openRunIds;
        yield* Effect.forEach(open, launch, { discard: true });
        yield* Effect.logInfo("Runs recovered from the run tables", {
          continuedAfterRunIds: continuations,
          openRunIds: open,
        });
      });

      return { launch, resume, stop, continueWithNewest, reconcile };
    }),
  );
}
