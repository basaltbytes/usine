import type { Attempt, AttemptId } from "@usine/core/attempt";
import * as AttemptChannel from "@usine/core/attempt/channel";
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
import { StepExecutor, type WorkerLease } from "../step-executor.ts";
import { RunStore } from "../store/store.ts";
import { TranscriptAllQuery } from "../transcript.ts";
import { TriggerCondition } from "../trigger-condition.ts";
import { AttemptAdmission } from "./admission.ts";
import { checkoutRecoveryFor, without } from "./checkout-recovery.ts";
import type {
  EnginePersistenceError,
  RunNotFoundError,
  RunOperationRejectedError,
  RunRetryBlockedError,
  RunStoreError,
} from "./error.ts";
import type { FinishDecision } from "./lifecycle.ts";
import { runIdFor, type Submission } from "./submission.ts";
import { UnconfirmedStop } from "./unconfirmed-stops.ts";

// Executor sinks fail with `AttemptFailure`: a persistence error becomes an `InfraFailure`, and
// other store errors are defects.
const asAttemptFailure = <A, R>(
  effect: Effect.Effect<A, RunStoreError, R>,
): Effect.Effect<A, AttemptFailure, R> =>
  Effect.catchTags(effect, {
    EnginePersistenceError: (error: EnginePersistenceError) =>
      new InfraFailure({
        message: `Runtime store error: could not ${error.operation}`,
        cause: error,
      }),
    RunNotFoundError: (error: RunNotFoundError) => Effect.die(error),
    RunOperationRejectedError: (error: RunOperationRejectedError) => Effect.die(error),
    RunRetryBlockedError: (error: RunRetryBlockedError) => Effect.die(error),
  });

/** The number of retries for a store operation that failed to persist. */
const STORE_RETRIES = 4;

/** The delay before the first retry; each later delay doubles. */
const STORE_RETRY_DELAY = "100 millis";

/**
 * Retries a store operation that fails with `EnginePersistenceError`, with exponential backoff.
 * Returns other errors and the last persistence error.
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
 * The state of a Run's open Attempt when this process starts driving the Run: a live parent
 * task, a stored result, or neither.
 */
type OpenAttempt =
  | { readonly _tag: "Live"; readonly attempt: Attempt }
  | {
      readonly _tag: "Finished";
      readonly attempt: Attempt;
      readonly result: Result.Result<StepResult, AttemptFailure>;
    }
  | { readonly _tag: "Interrupted"; readonly attempt: Attempt };

/** Returns the open Attempt if its parent task is live. */
const reattaching = (open: Option.Option<OpenAttempt>): Option.Option<Attempt> =>
  Option.flatMap(open, (found) =>
    found._tag === "Live" ? Option.some(found.attempt) : Option.none(),
  );

/**
 * The service that drives open Runs in this process, one fiber per Run. A fiber parks a gated
 * Run for approval, then reserves a Worker, starts or reattaches the Attempt, records its
 * outcome, and repeats until the Run closes. The fiber that closes a Run gives the Item's newest
 * queued Event its turn; cancel, supersede, and revoke do that themselves. A fiber that ends
 * without closing its Run leaves it for `resume` or `reconcile`.
 */
export class RunDriver extends Context.Service<
  RunDriver,
  {
    /** Starts the fiber of an open Run, unless one already runs here. */
    readonly launch: (runId: RunId) => Effect.Effect<void>;
    /** Starts the fiber of a Run that an approval or operator retry reopened, after its previous fiber ends. */
    readonly resume: (runId: RunId) => Effect.Effect<void>;
    /** Interrupts the fiber of a closed Run and waits for it to end. */
    readonly stop: (runId: RunId) => Effect.Effect<void>;
    /**
     * Gives the newest queued Event of the closed Run's Item its turn, after re-evaluating the
     * trigger against the Item's current state. If the Item is gone, marks its projection gone.
     */
    readonly continueWithNewest: (closedRunId: RunId) => Effect.Effect<void, RunStoreError>;
    /**
     * Opens the queued Events whose continuation didn't run and starts a fiber for every open Run
     * without one, except Runs waiting for approval. Also retries the parent task stops that
     * `releaseKept`, `recoverWorkspaces`, or the end of an Attempt couldn't confirm.
     */
    readonly reconcile: () => Effect.Effect<void, RunStoreError>;
    /** Returns the closed Attempts whose parent task stop `reconcile` retries. */
    readonly unconfirmedStops: Effect.Effect<ReadonlyArray<UnconfirmedStop>>;
    /**
     * Reconciles at startup the checkout of every persisted Attempt on a configured Worker, before
     * any Run admits its next Attempt. Keeps the checkout and occupies a Worker slot (#177) for
     * an open Attempt whose parent task is live or unreadable, and for a closed Attempt whose
     * parent task isn't confirmed stopped. See `checkoutRecoveryFor`.
     */
    readonly recoverWorkspaces: () => Effect.Effect<void, RunStoreError>;
    /**
     * Moves the slot that the fiber of Run `runId` holds to its Attempt `attemptId`, whose parent
     * task may still run, so the slot stays taken after the fiber frees it, until `releaseKept`
     * confirms that the parent task stopped (#475). Does nothing if the fiber holds no slot.
     */
    readonly holdSlot: (runId: RunId, attemptId: AttemptId) => Effect.Effect<void>;
    /**
     * Releases the slot kept for `attemptId`, an Attempt of Run `runId`: the slot that `holdSlot`
     * moved, or what `recoverWorkspaces` kept for reattaching it. Once the parent task is confirmed
     * stopped, reconciles a kept checkout and releases the slot; until then both stay kept (#177,
     * #475) and each `reconcile` retries.
     */
    readonly releaseKept: (runId: RunId, attemptId: AttemptId) => Effect.Effect<void>;
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
      // Closed Attempts whose parent task isn't confirmed stopped; each reconcile retries the stop.
      const unconfirmed = yield* Ref.make<ReadonlyMap<AttemptId, UnconfirmedStop>>(new Map());
      // The slot that each Run's fiber holds, unless `holdSlot` moved it to the Run's Attempt.
      const slots = yield* Ref.make<ReadonlyMap<RunId, WorkerLease>>(new Map());

      /** Releases `lease`, the slot of the Run's fiber, unless `holdSlot` moved it. */
      const releaseSlot = (runId: RunId, lease: WorkerLease) =>
        Ref.modify(slots, (held) =>
          held.get(runId) === lease ? [true, without(held, runId)] : [false, held],
        ).pipe(
          Effect.flatMap((owned) =>
            owned
              ? lease.release
              : Effect.logDebug(
                  "The Run's slot stays with its Attempt until the parent task is confirmed stopped",
                  { runId, worker: lease.worker },
                ),
          ),
        );

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
        const launchedBy = yield* Effect.option(Effect.currentSpan);
        yield* FiberMap.run(
          fibers,
          runId,
          drive(runId).pipe(
            Effect.withSpan("RunDriver.drive", {
              root: true,
              links: Option.toArray(Option.map(launchedBy, (span) => ({ span, attributes: {} }))),
            }),
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
          // The previous fiber ends right after its last write; wait until it leaves the map.
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
          retryingStore(closedRunId, "mark the item's projection gone"),
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
          .pipe(retryingStore(closedRunId, "read the queued events"));
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
          // Revoke only the queue read before the remote check.
          const revoked = yield* store
            .revokeQueued(queued.value)
            .pipe(retryingStore(closedRunId, "revoke the queued events"));
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
          .pipe(retryingStore(closedRunId, "claim the queued event"));
        if (Option.isNone(claimed)) {
          // During the check, the Event was ignored, another Run opened for the Item, or a cycle
          // reset superseded the Event.
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
       * Reads the state of the Run's open Attempt, or `None` if there is none. If a read fails,
       * logs a warning and returns `Interrupted`.
       */
      const openAttempt = Effect.fn("RunDriver.openAttempt")(function* (runId: RunId) {
        yield* Effect.annotateCurrentSpan({ runId });
        const current = yield* store.snapshot(runId).pipe(retryingStore(runId, "read the run"));
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
       * Returns the slot for the Run's next Attempt and the effect that reads the open Attempt once
       * the slot is held. A reattaching Run uses the slot startup occupied or waits for one on the
       * Attempt's Worker. Only the wait, through `restore`, is interruptible.
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
            runId,
            submission,
            Option.map(reattached, ({ worker }) => worker),
          ),
        );
        // The parent task can stop during the wait, so read it again before reattaching.
        return { lease, open: Option.isSome(reattached) ? openAttempt(runId) : found };
      });

      /**
       * Runs one Attempt on the reserved Worker and returns the resulting decision tag. `current`
       * reads the open Attempt once the slot is held.
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
            .pipe(retryingStore(runId, "finish the attempt"));
          if (finished._tag !== "RetryAttempt") return finished._tag;
        }
        const started = yield* store
          .beginAttempt(
            runId,
            worker,
            Option.map(reattaching(open), ({ id }) => id),
          )
          .pipe(retryingStore(runId, "begin the attempt"));
        if (started._tag === "AttemptRecoveryFailed") return "RunFailed";
        if (started._tag === "RunClosed") return "Unchanged";

        // An executor defect becomes a `DefectFailure`, which isn't retried automatically (ADR 0003).
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
              .pipe(retryingStore(runId, "read the attempt windows"), asAttemptFailure),
            transcript: store
              .transcript(new TranscriptAllQuery({ attemptId: started.execution.attempt.id }))
              .pipe(
                retryingStore(runId, "read the attempt transcript"),
                asAttemptFailure,
                // Reattached Attempts recorded the current protocol version. A version bump must
                // convert retired envelopes here for Attempts open across the upgrade.
                Effect.map((entries) =>
                  entries.flatMap(({ envelope }) =>
                    envelope.version === AttemptChannel.PROTOCOL_VERSION ? [envelope] : [],
                  ),
                ),
              ),
            // Until this point, the driver reconciles a checkout that startup kept, for example on
            // a cancel (#180).
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
                    message: "The step executor crashed with an unexpected error",
                    cause: defect,
                  }),
                ),
              ),
            ),
            Effect.result,
          );
        if (started.execution.reattach && Result.isFailure(result)) {
          // Reconcile a reattach that failed before acquiring the kept checkout, such as on a
          // credential error, so the next Attempt resumes from its salvage. `reconcile` does nothing
          // once the checkout was acquired, and fails this fiber while the stop is unconfirmed.
          yield* checkouts.reconcile(started.execution.attempt.id);
        }
        // Before the Attempt closes, so a cancel meanwhile still finds it open and keeps its slot.
        if (Result.isFailure(result))
          yield* confirmStopAfterFailure(runId, started.execution.attempt.id, worker);
        const finished = yield* store
          .finishAttempt(started.execution.attempt, result)
          .pipe(retryingStore(runId, "finish the attempt"));
        return finished._tag;
      });

      // `launch` traces it as the root span of the Run's own trace.
      const drive = Effect.fnUntraced(function* (runId: RunId) {
        const submission = yield* store
          .submission(runId)
          .pipe(retryingStore(runId, "read the run's submission"));
        yield* Effect.annotateCurrentSpan({
          runId,
          loop: submission.loop,
          itemKey: submission.itemKey,
        });
        if (
          submission.approval === "required" &&
          (yield* store
            .parkForApproval(runId)
            .pipe(retryingStore(runId, "park the run for approval")))._tag === "Waiting"
        ) {
          yield* Effect.logInfo("Run waits for its approval", { runId });
          return;
        }

        let outcome: FinishDecision["_tag"];
        do {
          // A reattached Attempt uses a slot on the Worker it started on (#177).
          const open = yield* openAttempt(runId);
          if (Option.isSome(open) && open.value._tag !== "Live") {
            // Reconcile before waiting for a slot, so the next Attempt resumes from the salvage and
            // the slot startup occupied is freed. If the stop can't be confirmed, this fiber fails
            // and keeps the slot; the next reconcile drives the Run again.
            yield* checkouts.reconcile(open.value.attempt.id);
          }
          // Only the slot wait is interruptible, so a cancel can stop a Run in `reserve`; the
          // scheduler releases or reoffers the slot on interrupt. `releaseSlot` runs once the
          // lease exists.
          outcome = yield* Effect.uninterruptibleMask((restore) =>
            slotFor(runId, submission, open, restore).pipe(
              Effect.tap(({ lease }) =>
                Ref.update(slots, (held) => new Map(held).set(runId, lease)),
              ),
              Effect.flatMap(({ lease, open: current }) =>
                restore(
                  admission.withAttempt(runId, executeAttempt(runId, lease.worker, current)),
                ).pipe(Effect.ensuring(releaseSlot(runId, lease))),
              ),
            ),
          );
        } while (outcome === "RetryAttempt");

        // Cancel, supersede, and revoke handle the Item's queued Events themselves and can
        // interrupt this fiber at any point.
        if (outcome === "Unchanged") {
          yield* Effect.logInfo("Run closed by another operation; its fiber ends", { runId });
          return;
        }
        yield* continueWithNewest(runId);
      });

      const holdSlot = Effect.fn("RunDriver.holdSlot")(function* (
        runId: RunId,
        attemptId: AttemptId,
      ) {
        yield* Effect.annotateCurrentSpan({ runId, attemptId });
        const lease = yield* Ref.modify(slots, (held) => [
          Option.fromUndefinedOr(held.get(runId)),
          without(held, runId),
        ]);
        if (Option.isNone(lease)) {
          yield* Effect.logDebug(
            "The Run's fiber holds no slot in this process; no slot moves to its Attempt",
            { runId, attemptId },
          );
          return;
        }
        yield* checkouts.hold(attemptId, lease.value);
      }, Effect.uninterruptible);

      /** Records `stop` for `reconcile` to retry, keeping the first record of its Attempt. */
      const recordUnconfirmed = (stop: UnconfirmedStop) =>
        Ref.update(unconfirmed, (stops) =>
          stops.has(stop.attemptId) ? stops : new Map(stops).set(stop.attemptId, stop),
        );

      /**
       * Confirms through `StepExecutor.interrupt` that the parent task of `attemptId`, which failed
       * on `worker`, stopped. The executor stops the task when an Attempt fails but doesn't report
       * whether the stop succeeded. If the stop isn't confirmed, the Attempt keeps the Run's slot,
       * as on a cancel, and each `reconcile` retries the stop (#512).
       */
      const confirmStopAfterFailure = Effect.fn("RunDriver.confirmStopAfterFailure")(function* (
        runId: RunId,
        attemptId: AttemptId,
        worker: WorkerName,
      ) {
        const fields = { runId, attemptId, worker };
        yield* Effect.annotateCurrentSpan(fields);
        const stopped = yield* executor.interrupt(attemptId).pipe(Effect.result);
        if (Result.isSuccess(stopped)) {
          yield* Effect.logDebug(
            "The parent task of the failed Attempt is confirmed stopped; the Run's slot is freed",
            fields,
          );
          return;
        }
        yield* Effect.logWarning(
          "Could not confirm that the parent task of the failed Attempt stopped; the Attempt keeps its Run's slot, and each reconcile tries the stop again",
          { ...fields, errorTag: stopped.failure._tag, message: stopped.failure.message },
        );
        yield* holdSlot(runId, attemptId).pipe(
          Effect.andThen(recordUnconfirmed(new UnconfirmedStop({ attemptId, runId, worker }))),
          Effect.uninterruptible,
        );
      });

      const releaseKept = Effect.fn("RunDriver.releaseKept")(function* (
        runId: RunId,
        attemptId: AttemptId,
      ) {
        yield* Effect.annotateCurrentSpan({ runId, attemptId });
        const stopped = yield* checkouts.reconcile(attemptId).pipe(Effect.result);
        if (Result.isSuccess(stopped)) {
          yield* Ref.update(unconfirmed, (stops) => without(stops, attemptId));
          return;
        }
        const { worker } = stopped.failure;
        yield* Effect.annotateCurrentSpan({ worker });
        yield* recordUnconfirmed(new UnconfirmedStop({ attemptId, runId, worker }));
        yield* Effect.logWarning(
          "The parent task of a closed Attempt is not confirmed stopped; its Worker's slot, and any checkout startup kept, stay kept, and the next reconcile tries the stop again",
          { runId, attemptId, worker },
        );
      });

      const recoverWorkspaces = Effect.fn("RunDriver.recoverWorkspaces")(function* () {
        // Closed Attempts whose parent task stop wasn't confirmed before the restart.
        const unstopped = yield* checkouts.atStartup();
        yield* Effect.forEach(
          unstopped,
          ({ attemptId, runId, worker }) =>
            recordUnconfirmed(new UnconfirmedStop({ attemptId, runId, worker })),
          { discard: true },
        );
      });

      const reconcile = Effect.fn("RunDriver.reconcile")(function* () {
        // No Run fiber retries these stops, so reconcile does.
        const unstopped = [...(yield* Ref.get(unconfirmed)).values()];
        yield* Effect.forEach(unstopped, ({ runId, attemptId }) => releaseKept(runId, attemptId), {
          discard: true,
        });
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
          retriedStopAttemptIds: unstopped.map(({ attemptId }) => attemptId),
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
        recoverWorkspaces,
        holdSlot,
        releaseKept,
        unconfirmedStops: Ref.get(unconfirmed).pipe(Effect.map((stops) => [...stops.values()])),
      };
    }),
  );
}
