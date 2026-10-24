import { AttemptId } from "@usine/core/attempt";
import type { AttemptRecovery } from "@usine/core/attempt/salvage";
import { Array as EffectArray, Effect, Option, Ref, Result, Schema } from "effect";
import type { StepExecutor, WorkerLease } from "../step-executor.ts";
import type { RunStore } from "../store/store.ts";

/**
 * An error for an Attempt whose parent task couldn't be confirmed stopped. Its checkout and
 * Worker slot stay kept, and the Run's next Attempt doesn't start.
 */
class ParentStopUnconfirmedError extends Schema.TaggedError<ParentStopUnconfirmedError>(
  "@usine/engine/internal/ParentStopUnconfirmedError",
)("ParentStopUnconfirmedError", {
  attemptId: AttemptId,
  cause: Schema.Defect(),
}) {}

const without = (
  leases: ReadonlyMap<AttemptId, WorkerLease>,
  attemptId: AttemptId,
): ReadonlyMap<AttemptId, WorkerLease> => {
  const remaining = new Map(leases);
  remaining.delete(attemptId);
  return remaining;
};

/**
 * Creates the checkout recovery steps that `RunDriver` uses at startup and on reattach.
 *
 * `atStartup` reconciles the checkouts left on Workers through `StepExecutor.recover`. It keeps
 * the checkout, and occupies a Worker slot through `StepExecutor.occupy` (#177), for an open
 * Attempt whose parent task is live or unreadable and for a closed Attempt whose parent task
 * isn't confirmed stopped. `acquired` hands a kept checkout and slot to the reattaching
 * execution. `reconcile` reconciles a kept checkout that the Run closes without that hand-off
 * (#180), and releases the slot once the parent task is confirmed stopped.
 */
export const checkoutRecoveryFor = Effect.fn("CheckoutRecovery.for")(function* (
  store: RunStore["Service"],
  executor: StepExecutor["Service"],
) {
  // The checkouts kept at startup, by Attempt, with their occupied slots.
  const kept = yield* Ref.make<ReadonlyMap<AttemptId, WorkerLease>>(new Map());

  /** Reconciles `attempt`'s checkout. On failure, logs an error and leaves the checkout on its Worker. */
  const recover = (attempt: AttemptRecovery) =>
    executor
      .recover(attempt, {
        salvage: (salvage) => store.recordSalvage(attempt.attemptId, salvage),
        comments: (comments) => store.recordComments(attempt.attemptId, comments),
        windows: store.attemptWindows(attempt.attemptId),
      })
      .pipe(
        Effect.tapError((error) =>
          Effect.logError("Attempt salvage reconciliation failed; work retained", {
            attemptId: attempt.attemptId,
            worker: attempt.worker,
            message: String(error),
          }),
        ),
        Effect.ignore,
      );

  /**
   * Keeps `attempt`'s checkout and occupies a slot on its Worker, recording the lease in the same
   * uninterruptible step. The lease's `release` frees the slot at most once.
   */
  const keep = Effect.fn("CheckoutRecovery.keep")(function* (attempt: AttemptRecovery) {
    yield* executor.occupy(attempt.worker).pipe(
      Effect.flatMap((lease) =>
        Effect.cached(lease.release).pipe(
          Effect.map((release) => ({ worker: lease.worker, release })),
        ),
      ),
      Effect.flatMap((lease) =>
        Ref.update(kept, (leases) => new Map(leases).set(attempt.attemptId, lease)),
      ),
      Effect.uninterruptible,
    );
  });

  /**
   * Keeps the checkout and a slot for an open Attempt whose parent task is live or whose liveness
   * can't be read. Otherwise reconciles the checkout.
   */
  const recoverOpen = Effect.fn("CheckoutRecovery.recoverOpen")(function* (
    attempt: AttemptRecovery,
  ) {
    const fields = { attemptId: attempt.attemptId, worker: attempt.worker };
    yield* Effect.annotateCurrentSpan(fields);
    const live = yield* executor.isLive(attempt.attemptId).pipe(Effect.result);
    if (Result.isSuccess(live) && !live.success) return yield* recover(attempt);
    if (Result.isFailure(live))
      yield* Effect.logWarning(
        "Could not read whether an open Attempt's parent task is live; its checkout stays for its Run to decide",
        { ...fields, errorTag: live.failure._tag, message: live.failure.message },
      );
    else
      yield* Effect.logInfo(
        "Leaving the checkout of an open Attempt whose parent task is live for its Run to reattach",
        fields,
      );
    yield* keep(attempt);
    yield* Effect.logInfo(
      "Occupied a slot on the Worker of an open Attempt kept for its Run to reattach",
      fields,
    );
  });

  /**
   * Reconciles a closed Attempt's checkout if its parent task is confirmed stopped. Otherwise
   * keeps the checkout and a slot, and returns the Attempt ID (#177).
   */
  const recoverClosed = Effect.fn("CheckoutRecovery.recoverClosed")(function* (
    attempt: AttemptRecovery,
  ) {
    const fields = { attemptId: attempt.attemptId, worker: attempt.worker };
    yield* Effect.annotateCurrentSpan(fields);
    // `recover` also stops the task, but its failure doesn't distinguish an unconfirmed stop from
    // a failed salvage.
    const stopped = yield* executor.interrupt(attempt.attemptId).pipe(Effect.result);
    if (Result.isSuccess(stopped)) {
      yield* recover(attempt);
      return Option.none<AttemptId>();
    }
    yield* Effect.logWarning(
      "Could not confirm that the parent task of a closed Attempt stopped; its checkout and a slot of its Worker stay kept until a reconcile confirms the stop",
      { ...fields, errorTag: stopped.failure._tag, message: stopped.failure.message },
    );
    yield* keep(attempt);
    return Option.some(attempt.attemptId);
  });

  /**
   * Reconciles every persisted Attempt on a configured Worker. Returns the closed Attempts whose
   * parent task isn't confirmed stopped.
   */
  const atStartup = Effect.fn("CheckoutRecovery.atStartup")(function* () {
    const configured = new Set(yield* executor.workers);
    const candidates = yield* store.salvageCandidates;
    const reconcilable = candidates.filter(({ worker }) => configured.has(worker));
    const unconfigured = candidates.filter(({ worker }) => !configured.has(worker));
    if (unconfigured.length > 0) {
      yield* Effect.logWarning(
        "Attempts recorded on Workers that are not configured were not reconciled; their checkouts stay until those Workers are configured again or their leftovers are discarded",
        {
          attempts: unconfigured.length,
          workers: [...new Set(unconfigured.map(({ worker }) => worker))].sort().join(","),
        },
      );
    }
    // Runs before Run recovery, so a retry starts only after the previous Attempt's work is
    // recorded. A failed recovery leaves the checkout on disk.
    const unstopped = yield* Effect.forEach(reconcilable, (attempt) =>
      attempt.open
        ? recoverOpen(attempt).pipe(Effect.as(Option.none<AttemptId>()))
        : recoverClosed(attempt),
    );
    return EffectArray.getSomes(unstopped);
  });

  /**
   * Returns the slot that startup occupied for `attemptId`, or `None`. Until the execution
   * acquires the checkout, the slot's `release` does nothing; `reconcile` frees it.
   */
  const reattachSlot = Effect.fn("CheckoutRecovery.reattachSlot")(function* (attemptId: AttemptId) {
    const occupied = Option.fromUndefinedOr((yield* Ref.get(kept)).get(attemptId));
    return Option.map(occupied, (lease): WorkerLease => ({
      worker: lease.worker,
      release: Ref.get(kept).pipe(
        Effect.flatMap((leases) =>
          leases.has(attemptId)
            ? Effect.logInfo(
                "The slot startup occupied stays kept with the checkout no execution acquired, until the Attempt's parent task is confirmed stopped",
                { attemptId, worker: lease.worker },
              )
            : lease.release,
        ),
      ),
    }));
  });

  /**
   * Hands the kept checkout of `attemptId` to its execution; the Run then releases the slot when
   * the Attempt ends. Does nothing for other Attempts.
   */
  const acquired = Effect.fn("CheckoutRecovery.acquired")(function* (attemptId: AttemptId) {
    const handedOver = yield* Ref.modify(kept, (leases) => [
      leases.has(attemptId),
      without(leases, attemptId),
    ]);
    if (handedOver)
      yield* Effect.logInfo(
        "The reattached Attempt's execution acquired the checkout startup kept; its executor releases the checkout from here, and its Run the slot once the Attempt ends",
        { attemptId },
      );
  });

  /**
   * Reconciles the kept checkout of `attemptId` after its parent task is confirmed stopped. Fails
   * with `ParentStopUnconfirmedError`, leaving the checkout, if the stop isn't confirmed.
   */
  const recoverKept = Effect.fn("CheckoutRecovery.recoverKept")(function* (attemptId: AttemptId) {
    // The parent task must stop before the reconcile or the next Attempt. `recover` also stops
    // it, but its failure doesn't distinguish an unconfirmed stop from a failed salvage.
    const stopped = yield* executor.interrupt(attemptId).pipe(Effect.result);
    if (Result.isFailure(stopped)) {
      yield* Effect.logWarning(
        "Could not confirm that the parent task of an Attempt its Run does not reattach stopped; its checkout and its Worker's slot stay, and the Run starts no next Attempt until the stop is confirmed",
        { attemptId, errorTag: stopped.failure._tag, message: stopped.failure.message },
      );
      return yield* new ParentStopUnconfirmedError({ attemptId, cause: stopped.failure });
    }
    const found = yield* store.salvageCandidate(attemptId).pipe(Effect.result);
    if (Result.isFailure(found)) {
      yield* Effect.logError(
        "Could not read the Attempt whose checkout startup kept; the checkout stays until the next startup",
        { attemptId, errorTag: found.failure._tag },
      );
      return;
    }
    if (Option.isNone(found.success)) {
      yield* Effect.logWarning(
        "The leftovers of the Attempt whose checkout startup kept were discarded; the checkout stays",
        { attemptId },
      );
      return;
    }
    const attempt = found.success.value;
    const fields = { attemptId, worker: attempt.worker, open: attempt.open };
    yield* Effect.annotateCurrentSpan(fields);
    if (!(yield* executor.workers).includes(attempt.worker)) {
      yield* Effect.logWarning(
        "The Worker of the Attempt whose checkout startup kept is no longer configured; the checkout stays until it is configured again or its leftovers are discarded",
        fields,
      );
      return;
    }
    // The Run doesn't reattach the Attempt, so reconcile even if `isLive` still reports it, as for
    // an unharvested parent report.
    yield* Effect.logInfo(
      "Reconciling the checkout startup kept for an Attempt that was not reattached",
      fields,
    );
    yield* recover(attempt);
  });

  const reconcile = Effect.fn("CheckoutRecovery.reconcile")(function* (attemptId: AttemptId) {
    yield* Effect.annotateCurrentSpan({ attemptId });
    const occupied = (yield* Ref.get(kept)).get(attemptId);
    if (occupied === undefined) {
      yield* Effect.logDebug("No checkout startup kept for the Attempt awaits reconciliation", {
        attemptId,
      });
      return;
    }
    yield* recoverKept(attemptId);
    // Removed only after reconciling, so a cancel during the reconcile reconciles again and the
    // slot stays taken while the parent task can still run (#177).
    yield* Ref.update(kept, (leases) => without(leases, attemptId)).pipe(
      Effect.andThen(occupied.release),
      Effect.uninterruptible,
    );
    yield* Effect.logInfo(
      "Released the slot startup occupied for an Attempt whose parent task is confirmed stopped",
      { attemptId, worker: occupied.worker },
    );
  });

  return { atStartup, reattachSlot, acquired, reconcile } as const;
});
