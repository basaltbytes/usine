import type { WorkerName } from "@usine/core/worker";
import { Effect, FileSystem, Path, type PlatformError, Ref, Result } from "effect";
import { keyedLockFor } from "../keyed-lock.ts";

/**
 * Lists each local Worker's leftover checkouts once for startup reconciliation.
 * Failed listings are remembered until the next executor starts, so an unreadable
 * Worker does not cause one filesystem request per historical Attempt.
 */
export const workerLeftoversFor = Effect.fn("LocalExecutor.workerLeftoversFor")(function* (
  workersRoot: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const locks = yield* keyedLockFor<WorkerName>();
  const listed = yield* Ref.make(
    new Map<WorkerName, Result.Result<ReadonlySet<string>, PlatformError.PlatformError>>(),
  );
  const list = Effect.fn("LocalExecutor.listWorkerLeftovers")(function* (worker: WorkerName) {
    yield* Effect.annotateCurrentSpan({ worker, host: "local" });
    const root = path.join(workersRoot, worker, "attempts");
    const entries = (yield* fileSystem.exists(root)) ? yield* fileSystem.readDirectory(root) : [];
    const checkouts = new Set(entries.map((entry) => path.join(root, entry)));
    yield* Effect.logInfo("Listed local checkouts left for reconciliation", {
      worker,
      host: "local",
      checkouts: checkouts.size,
    });
    return checkouts;
  });

  return Effect.fn("LocalExecutor.workerLeftovers")(function* (worker: WorkerName) {
    yield* Effect.annotateCurrentSpan({ worker, host: "local" });
    return yield* locks.withLock(worker)(
      Effect.gen(function* () {
        const known = (yield* Ref.get(listed)).get(worker);
        if (known !== undefined) return yield* Effect.fromResult(known);
        const result = yield* Effect.result(list(worker));
        yield* Ref.update(listed, (current) => new Map(current).set(worker, result));
        if (Result.isFailure(result)) {
          yield* Effect.logWarning(
            "Could not list local checkouts; this Worker is not reconciled until the next start",
            { worker, host: "local", message: String(result.failure) },
          );
        }
        return yield* Effect.fromResult(result);
      }),
    );
  });
});
