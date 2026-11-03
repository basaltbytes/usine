import { Effect } from "effect";
import { monitorEventLoopDelay } from "node:perf_hooks";

/** Logs p99 and maximum event-loop delay in milliseconds for each minute of server uptime. */
export const monitorEventLoop = Effect.gen(function* () {
  const histogram = yield* Effect.acquireRelease(
    Effect.sync(() => {
      const histogram = monitorEventLoopDelay({ resolution: 10 });
      histogram.enable();
      return histogram;
    }),
    (histogram) =>
      Effect.sync(() => {
        histogram.disable();
      }),
  );
  const report = Effect.fn("Server.eventLoopDelay")(function* () {
    yield* Effect.logInfo("Event-loop delay", {
      p99Millis: histogram.percentile(99) / 1_000_000,
      maxMillis: histogram.max / 1_000_000,
      intervalSeconds: 60,
    });
    histogram.reset();
  });
  yield* Effect.sleep("1 minute").pipe(Effect.andThen(report()), Effect.forever, Effect.forkScoped);
});
