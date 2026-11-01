import { Effect, Semaphore } from "effect";

/** Shares cleanup by physical location, including across connection changes to the same host. */
export const reclaimOnceFor = <A>(
  keyOf: (value: A) => string,
  reclaim: (value: A) => Effect.Effect<void>,
) =>
  Effect.gen(function* () {
    const completed = new Map<string, Effect.Effect<void>>();
    const exclusive = yield* Semaphore.make(1);
    return (value: A) =>
      exclusive
        .withPermit(
          Effect.gen(function* () {
            const key = keyOf(value);
            const existing = completed.get(key);
            if (existing !== undefined) return existing;
            const run = yield* Effect.cached(reclaim(value));
            completed.set(key, run);
            return run;
          }),
        )
        .pipe(Effect.flatten);
  });
