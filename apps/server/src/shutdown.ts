import { Duration, Effect, Fiber, Option } from "effect";

// NodeRuntime interrupts the main fiber on either signal. This observer keeps
// the second signal available while the interrupt finalizer drains the engine.
const secondSignal = Effect.callback<void>((resume) => {
  let received = 0;
  const onSignal = () => {
    received += 1;
    if (received === 2) resume(Effect.void);
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  return Effect.sync(() => {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
  });
});

/** Drains admitted work on interruption while the enclosing runtime scope stays open; a second signal or deadline ends the wait. */
export const withGracefulShutdown = <A, E, R>(
  running: Effect.Effect<A, E, R>,
  drain: Effect.Effect<void>,
  deadline: Duration.Duration,
): Effect.Effect<A, E, R> =>
  Effect.scoped(
    Effect.gen(function* () {
      const forced = yield* Effect.forkScoped(secondSignal, { startImmediately: true });
      return yield* running.pipe(
        Effect.onInterrupt(() =>
          Effect.gen(function* () {
            yield* Effect.logInfo("Orchestrator shutdown started", {
              deadlineMilliseconds: Duration.toMillis(deadline),
            });
            // Finalizers are uninterruptible. The raced child waits must remain
            // interruptible so the losing drain or signal wait can be stopped.
            const outcome = yield* Effect.raceFirst(
              drain.pipe(
                Effect.timeoutOption(deadline),
                Effect.map((result) =>
                  Option.isSome(result) ? ("drained" as const) : ("deadline" as const),
                ),
                Effect.interruptible,
              ),
              Fiber.join(forced).pipe(Effect.as("forced" as const), Effect.interruptible),
            );
            if (outcome === "drained") {
              yield* Effect.logInfo("Orchestrator exiting after graceful drain");
            } else {
              yield* Effect.logWarning(
                "Orchestrator stopping before drain completed; unfinished Attempts will recover on restart",
                { reason: outcome },
              );
            }
          }),
        ),
      );
    }),
  );
