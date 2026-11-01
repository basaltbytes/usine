import type { AttemptId } from "@usine/core/attempt";
import type { WorkerName } from "@usine/core/worker";
import { Effect, Option } from "effect";
import { ExecutorOperationError, type ExecutorError } from "./executor.ts";
import { keyedLockFor } from "./keyed-lock.ts";

/** Persists an attempt's connection through references to credentials, never resolved secrets. */
export interface AttemptConnections<A> {
  readonly read: (attemptId: AttemptId) => Effect.Effect<Option.Option<A>, ExecutorError>;
  readonly write: (attemptId: AttemptId, address: A) => Effect.Effect<void, ExecutorError>;
  readonly remove: (attemptId: AttemptId) => Effect.Effect<void, ExecutorError>;
}

export const attemptConnectionsFor = <A extends { readonly name: WorkerName }>(
  store: AttemptConnections<A> | undefined,
) =>
  Effect.gen(function* () {
    const addresses = new Map<AttemptId, A>();
    const locks = yield* keyedLockFor<AttemptId>();
    const resolve = Effect.fn("Executor.attemptConnection")(
      function* (
        worker: WorkerName,
        attemptId: AttemptId,
        current: Effect.Effect<A, ExecutorError>,
        purpose: "prepare" | "recovery" = "prepare",
      ) {
        yield* Effect.annotateCurrentSpan({ worker, attemptId });
        const cached = addresses.get(attemptId);
        if (cached !== undefined) return cached;
        const saved = store === undefined ? Option.none<A>() : yield* store.read(attemptId);
        const address = Option.isSome(saved) ? saved.value : yield* current;
        if (address.name !== worker)
          return yield* new ExecutorOperationError({
            operation: "prepare",
            message: "The recorded attempt connection belongs to another worker",
            cause: new Error(`Attempt ${attemptId} belongs to ${address.name}, not ${worker}`),
          });
        if (purpose === "prepare" && Option.isNone(saved) && store !== undefined)
          yield* store.write(attemptId, address);
        if (purpose === "prepare" || Option.isSome(saved)) addresses.set(attemptId, address);
        yield* Effect.logDebug("Resolved the attempt's worker connection", {
          worker,
          attemptId,
          restored: Option.isSome(saved),
        });
        return address;
      },
      (effect, _worker, attemptId) => effect.pipe(locks.withLock(attemptId)),
    );
    const forget = Effect.fn("Executor.forgetAttemptConnection")(function* (attemptId: AttemptId) {
      yield* Effect.annotateCurrentSpan({ attemptId });
      if (store !== undefined) yield* store.remove(attemptId);
      addresses.delete(attemptId);
    });
    return { resolve, forget };
  });
