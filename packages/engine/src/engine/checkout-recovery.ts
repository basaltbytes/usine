import type { AttemptRecovery } from "@usine/core/attempt/salvage";
import { Effect } from "effect";
import type { StepExecutor } from "../step-executor.ts";
import type { RunStore } from "../store/store.ts";

/**
 * Reconciles the checkouts that earlier processes left on the Workers through
 * `StepExecutor.recover`, recording what each one preserved in the run tables.
 * `RunDriver` exposes it to the engine.
 */
export const checkoutRecoveryFor = (
  store: RunStore["Service"],
  executor: StepExecutor["Service"],
) => {
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
    yield* Effect.forEach(reconcilable, recover, { discard: true });
  });

  return { atStartup } as const;
};
