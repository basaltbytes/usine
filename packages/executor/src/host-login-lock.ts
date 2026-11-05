import { HostLoginLock } from "@usine/agents/runtime";
import { jsonKey } from "@usine/core/json-key";
import { Effect, Layer, Option } from "effect";
import { keyedLockFor } from "./keyed-lock.ts";

/** Build once per process and share with preflight and session launch. */
export const hostLoginLockLayer: Layer.Layer<HostLoginLock> = Layer.effect(
  HostLoginLock,
  Effect.map(keyedLockFor<string>(), (locks) =>
    HostLoginLock.of({
      withLock: (harness, worker, machine) =>
        Effect.fn("HostLoginLock.withLock")(<A, E, R>(effect: Effect.Effect<A, E, R>) =>
          Effect.gen(function* () {
            const fields = {
              harness,
              worker,
              ...Option.match(machine, { onNone: () => ({}), onSome: (id) => ({ machine: id }) }),
            };
            yield* Effect.annotateCurrentSpan(fields);
            yield* Effect.logDebug("Waiting for the host login lock", fields);
            return yield* locks.withLock(jsonKey([harness, worker, Option.getOrNull(machine)]))(
              Effect.logDebug("Acquired the host login lock", fields).pipe(Effect.andThen(effect)),
            );
          }),
        ),
    }),
  ),
);
