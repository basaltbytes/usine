import type { LoadedInstance } from "@usine/config/instance";
import type { ProjectionRevision, RunReader } from "@usine/engine/run-reader";
import { Clock, Effect, Option, SynchronizedRef } from "effect";
import type { StatisticsWindow } from "./view.ts";

const MAX_AGE_MILLIS = 5 * 60 * 1_000;

interface CachedView<View> {
  readonly instance: LoadedInstance;
  readonly revision: ProjectionRevision;
  readonly expiresAt: number;
  readonly view: View;
}

export const cacheStatistics = <View, Error>(
  revision: RunReader["Service"]["revision"],
  compute: (instance: LoadedInstance, window: StatisticsWindow) => Effect.Effect<View, Error>,
) => {
  const windows = new Map<
    StatisticsWindow,
    SynchronizedRef.SynchronizedRef<Option.Option<CachedView<View>>>
  >();

  return Effect.fn("Operator.statistics.cached")(function* (
    instance: LoadedInstance,
    window: StatisticsWindow,
  ) {
    yield* Effect.annotateCurrentSpan({ window });
    let cache = windows.get(window);
    if (cache === undefined) {
      cache = SynchronizedRef.makeUnsafe(Option.none<CachedView<View>>());
      windows.set(window, cache);
    }
    return yield* SynchronizedRef.modifyEffect(cache, (cached) =>
      Effect.gen(function* () {
        const current = yield* revision();
        const now = yield* Clock.currentTimeMillis;
        if (
          Option.isSome(current) &&
          Option.isSome(cached) &&
          cached.value.revision === current.value &&
          cached.value.instance === instance &&
          now < cached.value.expiresAt
        ) {
          yield* Effect.logDebug("Statistics cache hit", { window, revision: current.value });
          return [cached.value.view, cached] as const;
        }
        yield* Effect.logDebug("Statistics cache miss", { window, revision: current });
        if (Option.isNone(current)) {
          yield* Effect.logWarning(
            "Projection revision singleton is missing; the statistics cache is bypassed",
            { window },
          );
        }
        const view = yield* compute(instance, window);
        return [
          view,
          Option.map(current, (revision) => ({
            instance,
            revision,
            expiresAt: now + MAX_AGE_MILLIS,
            view,
          })),
        ] as const;
      }),
    );
  });
};
