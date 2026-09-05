import type { RunId } from "@usine/core/run";
import { Context, Deferred, Effect, Layer, Ref } from "effect";

interface AdmissionState {
  readonly phase: "Accepting" | "Draining";
  readonly active: ReadonlySet<RunId>;
}

/** Process-local Attempt admission. Durable Runs stay recoverable when admission closes (ADR 0023). */
export class AttemptAdmission extends Context.Service<
  AttemptAdmission,
  {
    readonly enter: (runId: RunId) => Effect.Effect<boolean>;
    readonly leave: (runId: RunId) => Effect.Effect<void>;
    readonly drain: () => Effect.Effect<void>;
  }
>()("@usine/engine/AttemptAdmission") {
  static readonly layer = Layer.effect(
    AttemptAdmission,
    Effect.gen(function* () {
      const state = yield* Ref.make<AdmissionState>({ phase: "Accepting", active: new Set() });
      const empty = yield* Deferred.make<void>();

      const enter = Effect.fn("AttemptAdmission.enter")(function* (runId: RunId) {
        yield* Effect.annotateCurrentSpan({ runId });
        const admitted = yield* Ref.modify(state, (current) =>
          current.phase === "Draining"
            ? ([false, current] as const)
            : ([true, { ...current, active: new Set([...current.active, runId]) }] as const),
        );
        if (!admitted) {
          yield* Effect.logInfo("Attempt deferred until restart; the engine is draining", {
            runId,
          });
        }
        return admitted;
      });

      const leave = Effect.fn("AttemptAdmission.leave")(function* (runId: RunId) {
        yield* Effect.annotateCurrentSpan({ runId });
        const remaining = yield* Ref.updateAndGet(state, (current) => ({
          ...current,
          active: new Set([...current.active].filter((id) => id !== runId)),
        }));
        if (remaining.phase === "Draining") {
          yield* Effect.logInfo("Attempt settled during drain", {
            runId,
            remainingRunIds: [...remaining.active],
          });
          if (remaining.active.size === 0) yield* Deferred.succeed(empty, undefined);
        }
      });

      const drain = Effect.fn("AttemptAdmission.drain")(function* () {
        const current = yield* Ref.getAndUpdate(state, (value) => ({
          ...value,
          phase: "Draining" as const,
        }));
        yield* Effect.logInfo("Engine drain started; no further Attempts will be admitted", {
          activeRunIds: [...current.active],
        });
        if (current.active.size === 0) yield* Deferred.succeed(empty, undefined);
        yield* Deferred.await(empty);
        yield* Effect.logInfo("Engine drain completed; all admitted Attempts settled");
      });

      return { enter, leave, drain };
    }),
  );
}
