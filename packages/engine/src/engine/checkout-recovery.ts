import { AttemptId } from "@usine/core/attempt";
import type { AttemptRecovery } from "@usine/core/attempt/salvage";
import { Array as EffectArray, Effect, Option, Ref, Result, Schema } from "effect";
import type { StepExecutor, WorkerLease } from "../step-executor.ts";
import type { RunStore } from "../store/store.ts";

/**
 * The parent task of `attemptId`, an Attempt whose Run closes it without
 * reattaching it or closed it before a restart, could not be confirmed
 * stopped. Its checkout and the slot of its Worker stay kept, and the Run's
 * next Attempt does not start, so neither a new Attempt nor the reconcile
 * overtakes a task that may still run there.
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
 * Reconciles the checkouts that earlier processes left on the Workers through
 * `StepExecutor.recover`, recording what each one preserved in the run tables.
 * The checkout of an open Attempt whose parent task is live, or whose liveness
 * cannot be read, stays on its Worker for its Run. So does the checkout of a
 * closed Attempt whose parent task cannot be confirmed stopped, as after a
 * cancel that could not confirm the stop before the restart. Startup also
 * occupies a slot of that Worker for each of these Attempts through
 * `StepExecutor.occupy`, before any Run reserves one (#177). Both stay kept
 * while the parent task may still run, so no new Attempt takes the slot,
 * until an execution that reattaches the Attempt acquires the checkout:
 * `acquired` hands both to that execution, whose Run releases the slot when
 * the Attempt ends. `reconcile` gives them back when the Run closes the
 * Attempt before that hand-off: without reattaching it, after a reattachment
 * that failed first, or on a cancel (#180), and for a closed Attempt startup
 * kept. It releases the slot only once the parent task is confirmed stopped.
 * `RunDriver` exposes these steps to the engine.
 */
export const checkoutRecoveryFor = Effect.fn("CheckoutRecovery.for")(function* (
  store: RunStore["Service"],
  executor: StepExecutor["Service"],
) {
  // The Attempts whose checkout startup left on their Worker, each with the
  // slot it occupies there: an open one for its Run to reattach, and a closed
  // one whose parent task may still run. Each stays until an execution of its
  // Run acquires the checkout or a reconcile confirms that the task stopped.
  const kept = yield* Ref.make<ReadonlyMap<AttemptId, WorkerLease>>(new Map());

  /** Reconciles `attempt`'s checkout; a failure is logged and the checkout stays on its Worker. */
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
   * Keeps `attempt`'s checkout on its Worker with a slot of that Worker. The
   * Attempt is recorded in the same uninterruptible step as the lease, so no
   * slot is occupied unrecorded. Its release frees the slot once, since both
   * the Run that reattaches the Attempt and `reconcile` may call it.
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
   * Keeps the checkout of an open Attempt whose parent task is live for its
   * Run, with a slot of its Worker, and reconciles any other. One whose
   * liveness cannot be read is kept too: its Run reads it again before it
   * decides.
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
   * Reconciles the checkout of a closed Attempt once its parent task is
   * confirmed stopped, and returns the Attempt when it is not. A cancel
   * closes the Attempt before it stops the parent task, so that task may
   * outlive another restart when the stop failed (#177). Until the stop is
   * confirmed, the checkout stays on its Worker with a slot of that Worker,
   * and `reconcile` tries the stop again.
   */
  const recoverClosed = Effect.fn("CheckoutRecovery.recoverClosed")(function* (
    attempt: AttemptRecovery,
  ) {
    const fields = { attemptId: attempt.attemptId, worker: attempt.worker };
    yield* Effect.annotateCurrentSpan(fields);
    // `recover` stops the task too, but its failure cannot tell a stop it
    // could not confirm from a salvage that failed.
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
   * Reconciles every persisted Attempt on a configured Worker, keeping the
   * open ones `recoverOpen` keeps and the closed ones `recoverClosed` keeps.
   * Returns those closed Attempts, whose parent task is not confirmed stopped.
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
    // Before Run recovery can admit a retry, publish and durably record any
    // work left by its predecessor. Failed recovery keeps the checkout on disk.
    const unstopped = yield* Effect.forEach(reconcilable, (attempt) =>
      attempt.open
        ? recoverOpen(attempt).pipe(Effect.as(Option.none<AttemptId>()))
        : recoverClosed(attempt),
    );
    return EffectArray.getSomes(unstopped);
  });

  /**
   * The slot startup occupied for `attemptId`, for its Run to reattach the
   * Attempt in; none when startup kept nothing for it. Until the execution
   * acquires the checkout, the slot stays kept with it, and its `release`
   * frees nothing: a reattachment that fails or is canceled before then
   * holds the slot until `reconcile` confirms that the parent task stopped.
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
   * The execution of `attemptId` acquired its checkout: its executor salvages
   * and releases a checkout startup kept from here, and its Run releases the
   * slot when the Attempt ends. Does nothing for any other.
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
   * Reconciles the kept checkout of `attemptId`, whose Run closes it before
   * an execution acquired that checkout, once its parent task is confirmed
   * stopped. Fails with `ParentStopUnconfirmedError`, leaving the checkout,
   * when it is not.
   */
  const recoverKept = Effect.fn("CheckoutRecovery.recoverKept")(function* (attemptId: AttemptId) {
    // Neither the reconcile nor the Run's next Attempt may start while the
    // parent task may still write to the checkout. `recover` stops the task
    // too, but its failure cannot tell a stop it could not confirm from a
    // salvage that failed, which only leaves the checkout for the next startup.
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
    // The Run has decided not to reattach the Attempt. `recover` reconciles
    // the checkout even when `isLive` still reports the Attempt, as for a
    // parent's report that was never harvested.
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
    // Forgotten only once reconciled: when a cancel interrupts the Run's fiber
    // during the reconcile, the cancel reconciles the checkout again, and a
    // Run whose parent task was not confirmed stopped tries again. Until the
    // stop is confirmed, the parent task may still run on its Worker, so the
    // slot it occupies stays taken (#177).
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
