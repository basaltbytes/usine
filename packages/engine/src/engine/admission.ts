import type { RunId } from "@usine/core/run";
import { Context, Deferred, Effect, Layer, Option, Ref } from "effect";
import { RunEngineShutdown } from "./shutdown.ts";

/** The process-local gate for starting Attempts; closing it leaves durable Runs recoverable (ADR 0023). */
export class AttemptAdmission extends Context.Service<
  AttemptAdmission,
  {
    /** Runs `attempt` and tracks it until its outcome is persisted. If admission is closed, waits for runtime teardown. */
    readonly withAttempt: <A, E, R>(
      runId: RunId,
      attempt: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E, R>;
    readonly drain: () => Effect.Effect<void>;
  }
>()("@usine/engine/AttemptAdmission") {
  static readonly layer = Layer.effect(
    AttemptAdmission,
    Effect.gen(function* () {
      const hostShutdown = yield* Effect.serviceOption(RunEngineShutdown);
      const shutdown = Option.isSome(hostShutdown)
        ? hostShutdown.value
        : yield* Deferred.make<void>();
      const active = yield* Ref.make<ReadonlySet<RunId>>(new Set());
      const empty = yield* Deferred.make<void>();

      const enter = Effect.fn("AttemptAdmission.enter")(function* (runId: RunId) {
        yield* Effect.annotateCurrentSpan({ runId });
        // The host completes the latch synchronously on a signal, so the check and the set update
        // are in one atomic `Ref.modify`.
        const admitted = yield* Ref.modify(active, (current) =>
          Deferred.isDoneUnsafe(shutdown)
            ? ([false, current] as const)
            : ([true, new Set([...current, runId])] as const),
        );
        if (!admitted)
          yield* Effect.logInfo("Attempt deferred until restart; the engine is draining", {
            runId,
          });
        return admitted;
      });

      const leave = Effect.fn("AttemptAdmission.leave")(function* (runId: RunId) {
        yield* Effect.annotateCurrentSpan({ runId });
        const remaining = yield* Ref.updateAndGet(
          active,
          (current) => new Set([...current].filter((id) => id !== runId)),
        );
        if (yield* Deferred.isDone(shutdown)) {
          yield* Effect.logInfo("Attempt settled during drain", {
            runId,
            remainingRunIds: [...remaining],
          });
          if (remaining.size === 0) yield* Deferred.succeed(empty, undefined);
        }
      });

      const withAttempt = Effect.fn("AttemptAdmission.withAttempt")(function* <A, E, R>(
        runId: RunId,
        attempt: Effect.Effect<A, E, R>,
      ) {
        yield* Effect.annotateCurrentSpan({ runId });
        return yield* Effect.acquireUseRelease(
          enter(runId),
          (admitted) => (admitted ? attempt : Effect.never),
          (admitted) => (admitted ? leave(runId) : Effect.void),
        );
      });

      const drain = Effect.fn("AttemptAdmission.drain")(function* () {
        yield* Deferred.succeed(shutdown, undefined);
        const current = yield* Ref.get(active);
        yield* Effect.logInfo("Engine drain started; no further Attempts will be admitted", {
          activeRunIds: [...current],
        });
        if (current.size === 0) yield* Deferred.succeed(empty, undefined);
        yield* Deferred.await(empty);
        yield* Effect.logInfo("Engine drain completed; all admitted Attempts settled");
      });

      return { withAttempt, drain };
    }),
  );
}
