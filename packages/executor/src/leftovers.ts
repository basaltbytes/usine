import type { WorkerName } from "@usine/core/worker";
import { Cache, Effect } from "effect";

/**
 * Remembers what `list` found on each Worker for the life of one executor.
 * Startup reconciliation visits every persisted Attempt, so inspecting each one
 * on its Worker would stall startup on the whole Run history; after a Worker's
 * first listing, an Attempt with no leftover checkout costs nothing. Concurrent
 * callers for one Worker share that listing.
 *
 * A failed listing is remembered too: an unreachable Worker must not be retried
 * for each of its Attempts. Its checkouts stay in place for the next start.
 */
export const listedOncePerWorker = Effect.fn("Executor.listedOncePerWorker")(function* <A, E>(
  list: (worker: WorkerName) => Effect.Effect<A, E>,
) {
  // `Cache` stores the lookup's `Exit`, so a failure is answered from memory like
  // a success, and a lookup already in flight is joined rather than repeated.
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
