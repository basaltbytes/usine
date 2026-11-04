import { jsonKey } from "@usine/core/json-key";
import type { AttemptId } from "@usine/core/attempt";
import type { StepOutput } from "@usine/core/step/output";
import { DateTime, Effect, Layer, Option, Order, Ref } from "effect";
import type { EnginePersistenceError } from "../engine/error.ts";
import { StepOutputStore, StoredStepOutput } from "./store.ts";

// SQLite's binary collation compares UTF-8 bytes, independent of the host locale.
const binaryOrder = Order.mapInput(Order.Array(Order.Number), (value: string) =>
  Array.from(new TextEncoder().encode(value)),
);

/** Provides an independent store; `succeeded` reads the caller's attempt outcomes. */
export const memoryStepOutputLayer = (
  succeeded: (attemptId: AttemptId) => Effect.Effect<boolean, EnginePersistenceError>,
) =>
  Layer.effect(
    StepOutputStore,
    Effect.gen(function* () {
      const state = yield* Ref.make<
        ReadonlyMap<string, { readonly ref: StoredStepOutput; readonly output: StepOutput }>
      >(new Map());
      return StepOutputStore.of({
        write: Effect.fn("StepOutputStore.write")(function* (context, outputs) {
          yield* Effect.annotateCurrentSpan({ attemptId: context.attemptId, runId: context.runId });
          const createdAt = yield* DateTime.now;
          yield* Ref.update(state, (current) => {
            const next = new Map(current);
            for (const output of outputs) {
              const key = jsonKey([context.attemptId, output.name]);
              const previous = next.get(key);
              next.set(key, {
                ref: StoredStepOutput.make({
                  ...output.ref,
                  ...context,
                  createdAt: previous?.ref.createdAt ?? createdAt,
                }),
                output,
              });
            }
            return next;
          });
          yield* Effect.logInfo("Stored step outputs", {
            attemptId: context.attemptId,
            outputs: outputs.length,
          });
        }),
        list: Effect.fn("StepOutputStore.list")(function* (repository, itemNumber, type) {
          yield* Effect.annotateCurrentSpan({ repository, itemNumber });
          const current = yield* Ref.get(state);
          const matching = [...current.values()].filter(
            ({ ref }) =>
              ref.repository.toLowerCase() === repository.toLowerCase() &&
              Option.contains(ref.itemNumber, itemNumber) &&
              (Option.isNone(type) || ref.type === type.value),
          );
          const visible = yield* Effect.filter(matching, ({ ref }) => succeeded(ref.attemptId));
          return visible
            .map(({ ref }) => ref)
            .sort((a, b) => binaryOrder(a.attemptId, b.attemptId) || binaryOrder(a.name, b.name));
        }),
        read: Effect.fn("StepOutputStore.read")(function* (attemptId, name) {
          yield* Effect.annotateCurrentSpan({ attemptId, name });
          if (!(yield* succeeded(attemptId))) return Option.none();
          const current = yield* Ref.get(state);
          return Option.fromUndefinedOr(current.get(jsonKey([attemptId, name]))?.output);
        }),
      });
    }),
  );
