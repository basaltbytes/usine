import type { Attempt, AttemptId } from "@usine/core/attempt";
import { type AttemptFailure, DefectFailure, InfraFailure } from "@usine/core/attempt/failure";
import type { RunId } from "@usine/core/run";
import type { StepResult } from "@usine/core/step/result";
import type { WorkerName } from "@usine/core/worker";
import {
  Cause,
  Context,
  Crypto,
  DateTime,
  Effect,
  Fiber,
  FiberMap,
  Layer,
  Option,
  Ref,
  Result,
  Schedule,
} from "effect";
import { ItemProjectionWriter } from "../item-projection/item-projection.ts";
import { StepExecutor } from "../step-executor.ts";
import { RunStore } from "../store/store.ts";
import { TriggerCondition } from "../trigger-condition.ts";
import { AttemptAdmission } from "./admission.ts";
import { checkoutRecoveryFor } from "./checkout-recovery.ts";
import type {
  EnginePersistenceError,
  RunNotFoundError,
  RunOperationRejectedError,
  RunRetryBlockedError,
  RunStoreError,
} from "./error.ts";
import type { FinishDecision } from "./lifecycle.ts";
import { runIdFor, type Submission } from "./submission.ts";

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
    RunRetryBlockedError: (error: RunRetryBlockedError) => Effect.die(error),
  });

/** How many times a Run's fiber repeats a store operation that failed to persist before the fiber stops. */
const STORE_RETRIES = 4;

/** The wait before the first repeat; each later one waits twice as long. */
const STORE_RETRY_DELAY = "100 millis";

/**
 * Repeats a store operation that failed with an `EnginePersistenceError`, such
 * as a transient SQLite error, so one failed write does not stop the Run's
 * fiber. Other errors, and the last persistence error, reach the caller.
 */
const retryingStore =
  (runId: RunId, operation: string) =>
  <A>(effect: Effect.Effect<A, RunStoreError>): Effect.Effect<A, RunStoreError> =>
    effect.pipe(
      Effect.tapError((error) =>
        error._tag === "EnginePersistenceError"
          ? Effect.logWarning("A Run store operation failed to persist", {
              runId,
              operation,
              cause: error.cause,
            })
          : Effect.void,
      ),
      Effect.retry({
        schedule: Schedule.exponential(STORE_RETRY_DELAY),
        times: STORE_RETRIES,
        while: (error) => error._tag === "EnginePersistenceError",
      }),
    );

/**
 * What a Run's open Attempt left when this process started driving the Run: a
 * parent task to reattach, a result its parent task stored, or nothing the
 * Run can use, so the next Attempt replaces it.
 */
type OpenAttempt =
  | { readonly _tag: "Live"; readonly attempt: Attempt }
  | {
      readonly _tag: "Finished";
      readonly attempt: Attempt;
      readonly result: Result.Result<StepResult, AttemptFailure>;
    }
  | { readonly _tag: "Interrupted"; readonly attempt: Attempt };

/** The open Attempt the Run reattaches: the one `open` found with a live parent task. */
const reattaching = (open: Option.Option<OpenAttempt>): Option.Option<Attempt> =>
  Option.flatMap(open, (found) =>
    found._tag === "Live" ? Option.some(found.attempt) : Option.none(),
  );

/**
 * Drives open Runs in this process, one fiber per Run, with usine's run
 * tables as the only durable state. A Run's fiber parks a gated Run for
 * approval, then reserves a Worker, opens or reattaches the Attempt, records
 * its outcome, and repeats until the Run closes. A Run that reattaches its
 * open Attempt holds a slot of the Worker that Attempt runs on: the one
 * startup occupied for it, or else one it waits for (#177). A Run that does
 * not reattach it waits for a slot only once its parent task is confirmed
 * stopped. The fiber that closes its Run then gives the newest queued Event
 * of the Item its turn; when cancel, supersede, or revoke closes the Run
 * under its fiber, that operation takes care of the queued Events instead.
 * A fiber that ends without closing its Run (approval, operator retry, this
 * process stopping, a store failure that outlasted its retries, an open
 * Attempt's parent task it could not confirm stopped) leaves the Run for
 * `resume` or `reconcile`. The driver also reconciles the checkouts earlier
 * processes left, and keeps the checkout of an open Attempt whose parent task
 * is live, with a slot of its Worker, until an execution that reattaches the
 * Attempt acquires it, or the Run closes the Attempt first.
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
     * the queued Event may describe state the closed Run itself changed. An
     * Item its source no longer has also has its projection marked gone.
     */
    readonly continueWithNewest: (closedRunId: RunId) => Effect.Effect<void, RunStoreError>;
    /**
     * Recovers from the run tables: opens the queued Events whose continuation
     * did not run, and starts the fiber of every open Run that is not waiting
     * for its approval. Runs whose fiber already runs here are left alone. It
     * also tries again to stop the parent task of each Attempt `releaseKept`
     * could not confirm stopped.
     */
    readonly reconcile: () => Effect.Effect<void, RunStoreError>;
    /**
     * Reconciles at startup, through `StepExecutor.recover`, the checkout of
     * every persisted Attempt on a Worker the executor runs, recording its
     * salvage before any Run admits its next Attempt. An open Attempt whose
     * parent task is live, or whose liveness cannot be read, keeps its
     * checkout for its Run: the Run reattaches the Attempt, whose execution
     * acquires the checkout, or reconciles the checkout before its next
     * Attempt starts when it closes the Attempt without reattaching it or
     * the reattachment fails before acquiring it. When that Attempt's parent
     * task cannot be confirmed stopped, the Run's fiber stops before its next
     * Attempt, and the next reconcile drives the Run again. Each Attempt
     * whose checkout it keeps also occupies a slot of its Worker, through
     * `StepExecutor.occupy`, before any Run reserves one (#177). The slot
     * stays taken while the parent task may run: its Run reattaches the
     * Attempt in it, and the slot is released when the reattached Attempt
     * ends, or when the reconcile confirms that the parent task stopped.
     */
    readonly recoverWorkspaces: () => Effect.Effect<void, RunStoreError>;
    /**
     * Gives back what `recoverWorkspaces` kept for reattaching `attemptId`, an
     * Attempt whose Run closes it before an execution acquired its checkout,
     * as when the operator cancels the Run while it reads the Attempt, waits
     * for a Worker, or prepares the reattachment. Once the Attempt's parent
     * task is confirmed stopped, it reconciles the checkout, recording its
     * salvage, and releases the slot of the Attempt's Worker. Does nothing
     * for what startup did not keep or an execution acquired. While the stop
     * cannot be confirmed, the checkout and the slot stay kept, so no new
     * Attempt takes the slot (#177), and each `reconcile` tries again.
     */
    readonly releaseKept: (attemptId: AttemptId) => Effect.Effect<void>;
  }
>()("@usine/engine/internal/RunDriver") {
  static readonly layer = Layer.effect(
    RunDriver,
    Effect.gen(function* () {
      const store = yield* RunStore;
      const executor = yield* StepExecutor;
      const admission = yield* AttemptAdmission;
      const condition = yield* TriggerCondition;
      const items = yield* ItemProjectionWriter;
      const crypto = yield* Crypto.Crypto;
      const fibers = yield* FiberMap.make<RunId>();
      const checkouts = yield* checkoutRecoveryFor(store, executor);
      // The Attempts whose Run closed before using what startup kept for
      // them, while their parent task could not be confirmed stopped. Their
      // checkout and slot stay kept, and each reconcile tries the stop again.
      const unconfirmed = yield* Ref.make<ReadonlySet<AttemptId>>(new Set());

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
                    "The Run's fiber stopped on an engine failure; the next reconcile or a restart resumes it",
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

      const markItemGone = Effect.fn("RunDriver.markItemGone")(function* (
        closedRunId: RunId,
        submission: Submission,
      ) {
        yield* Effect.annotateCurrentSpan({ runId: closedRunId, itemKey: submission.itemKey });
        return yield* items.markGone(submission.itemKey, yield* DateTime.now).pipe(
          retryingStore(closedRunId, "mark the Item's projection gone"),
          Effect.catch((error) =>
            Effect.logWarning(
              "Could not mark the gone Item's projection; its Board card stays in place",
              {
                completedRunId: closedRunId,
                itemKey: submission.itemKey,
                errorTag: error._tag,
              },
            ).pipe(Effect.as(false)),
          ),
        );
      });

      const continueWithNewest = Effect.fn("RunDriver.continueWithNewest")(function* (
        closedRunId: RunId,
      ) {
        yield* Effect.annotateCurrentSpan({ runId: closedRunId });
        const queued = yield* store
          .nextQueued(closedRunId)
          .pipe(retryingStore(closedRunId, "read the queued Events"));
        if (Option.isNone(queued)) return;
        const submission = queued.value.submission;
        const fields = {
          completedRunId: closedRunId,
          eventId: submission.event.id,
          loop: submission.loop,
          itemKey: submission.itemKey,
        };
        const recheck = yield* condition.recheck(submission);
        if (recheck !== "matches") {
          // Only the queue observed before the remote check belongs to this result.
          const revoked = yield* store
            .revokeQueued(queued.value)
            .pipe(retryingStore(closedRunId, "revoke the queued Events"));
          if (recheck === "no-longer-matches") {
            yield* Effect.logInfo("Queued Event no longer matches its trigger; revoked", {
              ...fields,
              revokedEvents: revoked,
            });
            return;
          }
          const projectionMarkedGone = yield* markItemGone(closedRunId, submission);
          yield* Effect.logInfo(
            "Queued Event's Item is gone from its source; revoked its queued Events",
            { ...fields, revokedEvents: revoked, projectionMarkedGone },
          );
          return;
        }
        const runId = yield* runIdFor(submission).pipe(
          Effect.provideService(Crypto.Crypto, crypto),
        );
        const claimed = yield* store
          .claimQueued(submission, runId)
          .pipe(retryingStore(closedRunId, "claim the queued Event"));
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
       * What the Run's open Attempt left when this process started driving it:
       * a parent task to reattach, a result its parent task stored that the
       * Run never recorded, or neither. A read that fails is logged and treated
       * as finding neither. The Run reads it before it reserves a Worker, and
       * reads a live one again once it holds the slot. The Run closes an
       * Attempt it does not reattach once the checkout a restart kept for it
       * is reconciled, and the next Attempt resumes from that salvage.
       */
      const openAttempt = Effect.fn("RunDriver.openAttempt")(function* (runId: RunId) {
        yield* Effect.annotateCurrentSpan({ runId });
        const current = yield* store.snapshot(runId).pipe(retryingStore(runId, "read the Run"));
        const open = current.attempts.at(-1);
        if (
          current.run.state._tag !== "Running" ||
          open === undefined ||
          Option.isSome(open.outcome)
        )
          return Option.none<OpenAttempt>();
        const fields = { runId, attemptId: open.id, worker: open.worker };
        yield* Effect.annotateCurrentSpan({ attemptId: open.id, worker: open.worker });
        const live = yield* executor.isLive(open.id).pipe(Effect.result);
        if (Result.isFailure(live)) {
          yield* Effect.logWarning(
            "Could not read whether the open Attempt is live; the Run does not reattach it",
            { ...fields, errorTag: live.failure._tag, message: live.failure.message },
          );
          return Option.some<OpenAttempt>({ _tag: "Interrupted", attempt: open });
        }
        if (live.success) {
          yield* Effect.logInfo("The open Attempt's parent task is live; reattaching it", fields);
          return Option.some<OpenAttempt>({ _tag: "Live", attempt: open });
        }
        const stored = yield* executor.outcome(open.id).pipe(Effect.result);
        if (Result.isFailure(stored)) {
          yield* Effect.logWarning(
            "Could not read the open Attempt's stored outcome; the Run does not reattach it",
            { ...fields, errorTag: stored.failure._tag, message: stored.failure.message },
          );
          return Option.some<OpenAttempt>({ _tag: "Interrupted", attempt: open });
        }
        if (Option.isNone(stored.success)) {
          yield* Effect.logInfo(
            "The open Attempt's parent task is gone; the Run does not reattach it",
            fields,
          );
          return Option.some<OpenAttempt>({ _tag: "Interrupted", attempt: open });
        }
        const result = stored.success.value;
        yield* Effect.logInfo(
          "The open Attempt's parent task finished before this process recorded it; finishing the Attempt with its stored result",
          {
            ...fields,
            outcome: Result.match(result, {
              onSuccess: () => "Succeeded",
              onFailure: ({ _tag }) => _tag,
            }),
          },
        );
        return Option.some<OpenAttempt>({ _tag: "Finished", attempt: open, result });
      });

      /**
       * The slot the Run's next Attempt runs in, and how the Run reads its open
       * Attempt once it holds that slot. `open` is what `openAttempt` found. A
       * Run that reattaches its open Attempt takes the slot startup occupied
       * for it, or else waits for a slot of the Attempt's Worker. Any other Run
       * waits for a slot of any Worker. Only the wait, through `restore`, is
       * interruptible, so a slot the Run takes is never lost.
       */
      const slotFor = Effect.fn("RunDriver.slot")(function* (
        runId: RunId,
        submission: Submission,
        open: Option.Option<OpenAttempt>,
        restore: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>,
      ) {
        yield* Effect.annotateCurrentSpan({ runId });
        const found = Effect.succeed(open);
        const reattached = reattaching(open);
        if (Option.isSome(reattached)) {
          const occupied = yield* checkouts.reattachSlot(reattached.value.id);
          if (Option.isSome(occupied)) {
            yield* Effect.logInfo(
              "The Run reattaches its open Attempt in the slot startup occupied on its Worker",
              { runId, attemptId: reattached.value.id, worker: occupied.value.worker },
            );
            return { lease: occupied.value, open: found };
          }
        }
        const lease = yield* restore(
          executor.reserve(
            submission,
            Option.map(reattached, ({ worker }) => worker),
          ),
        );
        // The parent task of a live Attempt may stop while its Run waits for a
        // slot of its Worker, so the Run reads it again before reattaching it.
        return { lease, open: Option.isSome(reattached) ? openAttempt(runId) : found };
      });

      /**
       * Runs one Attempt on the reserved Worker and returns what it did to the
       * Run. `current` reads what the Run's open Attempt left, once the Run
       * holds its slot.
       */
      const executeAttempt = Effect.fn("RunDriver.attempt")(function* (
        runId: RunId,
        worker: WorkerName,
        current: Effect.Effect<Option.Option<OpenAttempt>, RunStoreError>,
      ) {
        yield* Effect.annotateCurrentSpan({ runId, worker });
        const open = yield* current;
        if (Option.isSome(open) && open.value._tag === "Finished") {
          const finished = yield* store
            .finishAttempt(open.value.attempt, open.value.result)
            .pipe(retryingStore(runId, "finish the Attempt"));
          if (finished._tag !== "RetryAttempt") return finished._tag;
        }
        const started = yield* store
          .beginAttempt(
            runId,
            worker,
            Option.map(reattaching(open), ({ id }) => id),
          )
          .pipe(retryingStore(runId, "begin the Attempt"));
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
            comments: (comments) =>
              store.recordComments(started.execution.attempt.id, comments).pipe(asAttemptFailure),
            windows: store
              .attemptWindows(started.execution.attempt.id)
              .pipe(retryingStore(runId, "read the Attempt windows"), asAttemptFailure),
            // A checkout startup kept stays this driver's to reconcile until
            // here: a cancel before it reconciles the checkout (#180).
            checkoutAcquired: checkouts.acquired(started.execution.attempt.id),
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
        if (started.execution.reattach && Result.isFailure(result)) {
          // A reattachment that failed before its execution acquired the
          // checkout startup kept, such as one whose credential could not be
          // issued, is reconciled while the Attempt is still open, so the next
          // Attempt resumes from its salvage. `reconcile` does nothing once the
          // checkout was acquired. While the parent task's stop is unconfirmed,
          // it stops this fiber, as for an Attempt the Run does not reattach,
          // and the slot the Run reattached in stays kept.
          yield* checkouts.reconcile(started.execution.attempt.id);
        }
        const finished = yield* store
          .finishAttempt(started.execution.attempt, result)
          .pipe(retryingStore(runId, "finish the Attempt"));
        return finished._tag;
      });

      const drive = Effect.fn("RunDriver.drive")(function* (runId: RunId) {
        const submission = yield* store
          .submission(runId)
          .pipe(retryingStore(runId, "read the Run's Submission"));
        yield* Effect.annotateCurrentSpan({
          runId,
          loop: submission.loop,
          itemKey: submission.itemKey,
        });
        if (
          submission.approval === "required" &&
          (yield* store
            .parkForApproval(runId)
            .pipe(retryingStore(runId, "park the Run for approval")))._tag === "Waiting"
        ) {
          yield* Effect.logInfo("Run waits for its approval", { runId });
          return;
        }

        let outcome: FinishDecision["_tag"];
        do {
          // A reattached Attempt's parent task and checkout stay on the Worker
          // it started on, so its Run holds a slot of that Worker (#177).
          const open = yield* openAttempt(runId);
          if (Option.isSome(open) && open.value._tag !== "Live") {
            // Reconciled while the Attempt is still open, as startup reconciles
            // one, so the next Attempt resumes from its salvage. The slot
            // startup occupied for the Attempt is freed only once its parent
            // task is confirmed stopped, and before the Run waits for a slot,
            // which could otherwise need this very one. A stop that cannot be
            // confirmed fails this fiber and keeps the slot; the next reconcile
            // drives the Run again, which reads whether the Attempt is live
            // once more.
            yield* checkouts.reconcile(open.value.attempt.id);
          }
          // The wait for a worker slot stays interruptible so a cancel can reach a run
          // parked in `reserve`; the scheduler releases or reoffers the slot in its own
          // onInterrupt. The release obligation begins only once the lease exists.
          outcome = yield* Effect.uninterruptibleMask((restore) =>
            slotFor(runId, submission, open, restore).pipe(
              Effect.flatMap(({ lease, open: current }) =>
                restore(
                  admission.withAttempt(runId, executeAttempt(runId, lease.worker, current)),
                ).pipe(Effect.ensuring(lease.release)),
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

      const releaseKept = Effect.fn("RunDriver.releaseKept")(function* (attemptId: AttemptId) {
        yield* Effect.annotateCurrentSpan({ attemptId });
        const stopped = yield* checkouts.reconcile(attemptId).pipe(Effect.result);
        yield* Ref.update(unconfirmed, (ids) => {
          const next = new Set(ids);
          if (Result.isSuccess(stopped)) next.delete(attemptId);
          else next.add(attemptId);
          return next;
        });
        if (Result.isFailure(stopped))
          yield* Effect.logWarning(
            "The parent task of an Attempt whose Run closed is not confirmed stopped; its checkout and its Worker's slot stay kept, and the next reconcile tries the stop again",
            { attemptId },
          );
      });

      const reconcile = Effect.fn("RunDriver.reconcile")(function* () {
        // A closed Run's fiber no longer drives the Attempt whose stop it could not confirm.
        const unstopped = [...(yield* Ref.get(unconfirmed))];
        yield* Effect.forEach(unstopped, releaseKept, { discard: true });
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
        const driven = yield* store.runIdsToDrive;
        const withoutFiber = yield* Effect.filter(driven, (runId) =>
          Effect.map(FiberMap.has(fibers, runId), (running) => !running),
        );
        yield* Effect.forEach(withoutFiber, launch, { discard: true });
        const fields = {
          continuedAfterRunIds: continuations,
          startedRunIds: withoutFiber,
          drivenRunIds: driven.length,
          retriedStopAttemptIds: unstopped,
        };
        if (continuations.length === 0 && withoutFiber.length === 0 && unstopped.length === 0)
          yield* Effect.logDebug("Every Run to drive already has its fiber", fields);
        else yield* Effect.logInfo("Runs recovered from the run tables", fields);
      });

      return {
        launch,
        resume,
        stop,
        continueWithNewest,
        reconcile,
        recoverWorkspaces: checkouts.atStartup,
        releaseKept,
      };
    }),
  );
}
