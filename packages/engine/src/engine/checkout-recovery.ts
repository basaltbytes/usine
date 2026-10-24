import { AttemptId } from "@usine/core/attempt";
import type { AttemptRecovery } from "@usine/core/attempt/salvage";
import { WorkerName } from "@usine/core/worker";
import { Array as EffectArray, Effect, Option, Ref, Result, Schema } from "effect";
import type { StepExecutor, WorkerLease } from "../step-executor.ts";
import type { RunStore, SalvageCandidate } from "../store/store.ts";

/**
 * An error for an Attempt whose parent task couldn't be confirmed stopped. Its slot of `worker`,
 * and any checkout startup kept, stay kept, and the Run's next Attempt doesn't start.
 */
class ParentStopUnconfirmedError extends Schema.TaggedError<ParentStopUnconfirmedError>(
  "@usine/engine/internal/ParentStopUnconfirmedError",
)("ParentStopUnconfirmedError", {
  attemptId: AttemptId,
  worker: WorkerName,
  cause: Schema.Defect(),
}) {}

/** Returns `map` without `key`. */
export const without = <K, V>(map: ReadonlyMap<K, V>, key: K): ReadonlyMap<K, V> => {
  const remaining = new Map(map);
  remaining.delete(key);
  return remaining;
};

/** The Worker slot of an Attempt whose parent task may still run. `release` runs at most once. */
interface Occupied extends WorkerLease {
  /** Whether startup kept the checkout, which `reconcile` reconciles once the parent task stops. */
  readonly checkoutKept: boolean;
}

/**
 * Creates the checkout recovery steps that `RunDriver` uses at startup, on reattach, and on cancel.
 *
 * `atStartup` reconciles the checkouts left on Workers through `StepExecutor.recover`. It keeps
 * the checkout, and occupies a Worker slot through `StepExecutor.occupy` (#177), for an open
 * Attempt whose parent task is live or unreadable and for a closed Attempt whose parent task
 * isn't confirmed stopped. `acquired` hands a kept checkout and slot to the reattaching
 * execution. `hold` keeps the slot of an Attempt whose parent task may still run after a cancel
 * or a failure (#475, #512). `reconcile` reconciles a kept checkout that the Run closes without
 * that hand-off (#180), and releases the slot once the parent task is confirmed stopped.
 */
export const checkoutRecoveryFor = Effect.fn("CheckoutRecovery.for")(function* (
  store: RunStore["Service"],
  executor: StepExecutor["Service"],
) {
  // The slots of Attempts whose parent task may still run, by Attempt.
  const kept = yield* Ref.make<ReadonlyMap<AttemptId, Occupied>>(new Map());

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
   * uninterruptible step.
   */
  const keep = Effect.fn("CheckoutRecovery.keep")(function* (attempt: AttemptRecovery) {
    yield* executor.occupy(attempt.worker).pipe(
      Effect.flatMap((lease) =>
        Effect.cached(lease.release).pipe(
          Effect.map((release): Occupied => ({
            worker: lease.worker,
            release,
            checkoutKept: true,
          })),
        ),
      ),
      Effect.flatMap((occupied) =>
        Ref.update(kept, (leases) => new Map(leases).set(attempt.attemptId, occupied)),
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
   * keeps the checkout and a slot, and returns the Attempt (#177).
   */
  const recoverClosed = Effect.fn("CheckoutRecovery.recoverClosed")(function* (
    attempt: SalvageCandidate,
  ) {
    const fields = { attemptId: attempt.attemptId, runId: attempt.runId, worker: attempt.worker };
    yield* Effect.annotateCurrentSpan(fields);
    // `recover` also stops the task, but its failure doesn't distinguish an unconfirmed stop from
    // a failed salvage.
    const stopped = yield* executor.interrupt(attempt.attemptId).pipe(Effect.result);
    if (Result.isSuccess(stopped)) {
      yield* recover(attempt);
      return Option.none<SalvageCandidate>();
    }
    yield* Effect.logWarning(
      "Could not confirm that the parent task of a closed Attempt stopped; its checkout and a slot of its Worker stay kept until a reconcile confirms the stop",
      { ...fields, errorTag: stopped.failure._tag, message: stopped.failure.message },
    );
    yield* keep(attempt);
    return Option.some(attempt);
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
        ? recoverOpen(attempt).pipe(Effect.as(Option.none<SalvageCandidate>()))
        : recoverClosed(attempt),
    );
    return EffectArray.getSomes(unstopped);
  });

  /**
   * Returns the slot that startup occupied with the checkout it kept for `attemptId`, or `None`.
   * Until the execution acquires the checkout, the slot's `release` does nothing; `reconcile`
   * frees it.
   */
  const reattachSlot = Effect.fn("CheckoutRecovery.reattachSlot")(function* (attemptId: AttemptId) {
    const occupied = Option.filter(
      Option.fromUndefinedOr((yield* Ref.get(kept)).get(attemptId)),
      ({ checkoutKept }) => checkoutKept,
    );
    return Option.map(occupied, (entry): WorkerLease => ({
      worker: entry.worker,
      release: Ref.get(kept).pipe(
        Effect.flatMap((leases) =>
          leases.get(attemptId) === entry
            ? Effect.logInfo(
                "The slot startup occupied stays kept with the checkout no execution acquired, until the Attempt's parent task is confirmed stopped",
                { attemptId, worker: entry.worker },
              )
            : entry.release,
        ),
      ),
    }));
  });

  /**
   * Hands the kept checkout of `attemptId` to its execution; the Run then releases the slot when
   * the Attempt ends. Does nothing for other Attempts.
   */
  const acquired = Effect.fn("CheckoutRecovery.acquired")(function* (attemptId: AttemptId) {
    const handedOver = yield* Ref.modify(kept, (leases) =>
      leases.get(attemptId)?.checkoutKept === true
        ? [true, without(leases, attemptId)]
        : [false, leases],
    );
    if (handedOver)
      yield* Effect.logInfo(
        "The reattached Attempt's execution acquired the checkout startup kept; its executor releases the checkout from here, and its Run the slot once the Attempt ends",
        { attemptId },
      );
  });

  /**
   * Keeps `lease` as the slot of `attemptId`, an Attempt whose parent task may still run, until
   * `reconcile` confirms that the task stopped. If the Attempt already has a slot here, releases
   * `lease` instead.
   */
  const hold = Effect.fn("CheckoutRecovery.hold")(function* (
    attemptId: AttemptId,
    lease: WorkerLease,
  ) {
    const fields = { attemptId, worker: lease.worker };
    yield* Effect.annotateCurrentSpan(fields);
    const release = yield* Effect.cached(lease.release);
    const held = yield* Ref.modify(kept, (leases) =>
      leases.has(attemptId)
        ? [false, leases]
        : [
            true,
            new Map(leases).set(attemptId, {
              worker: lease.worker,
              release,
              checkoutKept: false,
            }),
          ],
    );
    if (held) {
      yield* Effect.logInfo(
        "The Attempt keeps its Run's slot until its parent task is confirmed stopped",
        fields,
      );
      return;
    }
    yield* Effect.logDebug(
      "The Attempt already has a slot kept until its parent task is confirmed stopped; releasing its Run's lease",
      fields,
    );
    yield* release;
  }, Effect.uninterruptible);

  /**
   * Stops the parent task of `attemptId`. Fails with `ParentStopUnconfirmedError` if the stop isn't
   * confirmed.
   */
  const confirmStop = Effect.fn("CheckoutRecovery.confirmStop")(function* (
    attemptId: AttemptId,
    occupied: Occupied,
  ) {
    const fields = { attemptId, worker: occupied.worker, checkoutKept: occupied.checkoutKept };
    yield* Effect.annotateCurrentSpan(fields);
    const stopped = yield* executor.interrupt(attemptId).pipe(Effect.result);
    if (Result.isSuccess(stopped)) return;
    const failure = { ...fields, errorTag: stopped.failure._tag, message: stopped.failure.message };
    yield* occupied.checkoutKept
      ? Effect.logWarning(
          "Could not confirm that the parent task of an Attempt its Run does not reattach stopped; its checkout and its Worker's slot stay, and the Run starts no next Attempt until the stop is confirmed",
          failure,
        )
      : Effect.logWarning(
          "Could not confirm that the parent task of a closed Attempt stopped; its Worker's slot stays taken until a reconcile confirms the stop",
          failure,
        );
    return yield* new ParentStopUnconfirmedError({
      attemptId,
      worker: occupied.worker,
      cause: stopped.failure,
    });
  });

  /** Reconciles the checkout startup kept for `attemptId`, whose parent task is confirmed stopped. */
  const recoverKept = Effect.fn("CheckoutRecovery.recoverKept")(function* (attemptId: AttemptId) {
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
      yield* Effect.logDebug("No slot kept for the Attempt awaits its parent task's stop", {
        attemptId,
      });
      return;
    }
    // The parent task must stop before the reconcile, the next Attempt, or the slot's release.
    yield* confirmStop(attemptId, occupied);
    if (occupied.checkoutKept) yield* recoverKept(attemptId);
    // Removed only after reconciling, so a cancel during the reconcile reconciles again and the
    // slot stays taken while the parent task can still run (#177).
    yield* Ref.update(kept, (leases) => without(leases, attemptId)).pipe(
      Effect.andThen(occupied.release),
      Effect.uninterruptible,
    );
    yield* Effect.logInfo(
      "Released the slot kept for an Attempt whose parent task is confirmed stopped",
      { attemptId, worker: occupied.worker, checkoutKept: occupied.checkoutKept },
    );
  });

  return { atStartup, reattachSlot, acquired, hold, reconcile } as const;
});
