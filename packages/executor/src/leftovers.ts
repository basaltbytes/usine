import type { WorkerName } from "@usine/core/worker";
import { Cache, Effect } from "effect";

/**
 * Caches `list` per Worker for the life of one executor; concurrent callers share one listing.
 * Failures are cached too, so an unreachable Worker is listed once and its checkouts stay until
 * the next start.
 */
export const listedOncePerWorker = Effect.fn("Executor.listedOncePerWorker")(function* <A, E>(
  list: (worker: WorkerName) => Effect.Effect<A, E>,
) {
  const listed = yield* Cache.make({
    capacity: Number.POSITIVE_INFINITY,
    lookup: (worker: WorkerName) =>
      list(worker).pipe(
        Effect.tapError((error) =>
          Effect.logWarning(
            "Could not list leftover checkouts; this Worker is not reconciled until the next start",
            { worker, message: String(error) },
          ),
        ),
      ),
  });
  return (worker: WorkerName) => Cache.get(listed, worker);
});
