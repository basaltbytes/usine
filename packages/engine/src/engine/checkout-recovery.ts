import type { AttemptId } from "@usine/core/attempt";
import type { AttemptRecovery } from "@usine/core/attempt/salvage";
import { Effect, Option, Ref, Result } from "effect";
import type { StepExecutor } from "../step-executor.ts";
import type { RunStore } from "../store/store.ts";

const without = (ids: ReadonlySet<AttemptId>, attemptId: AttemptId): ReadonlySet<AttemptId> => {
  const remaining = new Set(ids);
  remaining.delete(attemptId);
  return remaining;
};

/**
 * Reconciles the checkouts that earlier processes left on the Workers through
 * `StepExecutor.recover`, recording what each one preserved in the run tables.
 * The checkout of an open Attempt whose parent task is live stays on its
 * Worker for its Run: `reattached` hands it to the Run's execution, and
 * `reconcile` reconciles it once the Run closes the Attempt without
 * reattaching it (#180). `RunDriver` exposes both steps to the engine.
 */
export const checkoutRecoveryFor = Effect.fn("CheckoutRecovery.for")(function* (
  store: RunStore["Service"],
  executor: StepExecutor["Service"],
) {
  // The open Attempts whose checkout startup left on their Worker for a
  // reattachment. Each stays until its Run reattaches the Attempt or
  // reconciles the checkout.
  const kept = yield* Ref.make<ReadonlySet<AttemptId>>(new Set());

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
   * Keeps the checkout of an open Attempt whose parent task is live for its
   * Run, and reconciles any other. One whose liveness cannot be read is kept
   * too: its Run reads it again before it decides.
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
    yield* Ref.update(kept, (ids) => new Set(ids).add(attempt.attemptId));
  });

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
    yield* Effect.forEach(
      reconcilable,
      (attempt) => (attempt.open ? recoverOpen(attempt) : recover(attempt)),
      { discard: true },
    );
  });

  /** The Run reattached `attemptId`: its execution takes over the checkout startup kept. */
  const reattached = (attemptId: AttemptId) => Ref.update(kept, (ids) => without(ids, attemptId));

  /** Reconciles the kept checkout of `attemptId`, whose Run closes it without reattaching it. */
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
    // The Run has decided not to reattach the Attempt. `recover` stops a
    // parent task that is still live, then reconciles the checkout even when
    // `isLive` still reports the Attempt, as for a parent's report that was
    // never harvested.
    yield* Effect.logInfo(
      "Reconciling the checkout startup kept for an Attempt that was not reattached",
      fields,
    );
    yield* recover(attempt);
  });

  const reconcile = Effect.fn("CheckoutRecovery.reconcile")(function* (attemptId: AttemptId) {
    yield* Effect.annotateCurrentSpan({ attemptId });
    if (!(yield* Ref.get(kept)).has(attemptId)) {
      yield* Effect.logDebug("Startup kept no checkout for the Attempt; nothing to reconcile", {
        attemptId,
      });
      return;
    }
    yield* recoverKept(attemptId);
    // Forgotten only once reconciled: when a cancel interrupts the Run's fiber
    // during the reconcile, the cancel reconciles the checkout again.
    yield* Ref.update(kept, (ids) => without(ids, attemptId));
  });

  return { atStartup, reattached, reconcile } as const;
});
