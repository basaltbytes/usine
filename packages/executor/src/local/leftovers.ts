import type { WorkerName } from "@usine/core/worker";
import { Effect, FileSystem, Path } from "effect";
import { listedOncePerWorker } from "../leftovers.ts";

/**
 * Lists the checkout paths left under each local Worker's `attempts` directory,
 * once per Worker for this executor. A Worker that never ran an Attempt has none.
 */
export const workerLeftoversFor = Effect.fn("LocalExecutor.workerLeftoversFor")(function* (
  workersRoot: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return yield* listedOncePerWorker(
    Effect.fn("LocalExecutor.listWorkerLeftovers")(function* (worker: WorkerName) {
      yield* Effect.annotateCurrentSpan({ worker, host: "local" });
      const root = path.join(workersRoot, worker, "attempts");
      const entries = (yield* fileSystem.exists(root)) ? yield* fileSystem.readDirectory(root) : [];
      const checkouts: ReadonlySet<string> = new Set(
        entries.map((entry) => path.join(root, entry)),
      );
      yield* Effect.logInfo("Listed local checkouts left for reconciliation", {
        worker,
        host: "local",
        checkouts: checkouts.size,
      });
      return checkouts;
    }),
  );
});
