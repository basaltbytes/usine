import { Deferred, Duration, Effect, Exit, Fiber, Option, Scope } from "effect";

// This listener runs before NodeRuntime's main-fiber interruption. Admission is
// closed synchronously at the signal boundary, including during Layer startup.
const observeSignals = (requested: Deferred.Deferred<void>, forced: Deferred.Deferred<void>) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      let received = 0;
      const onSignal = () => {
        received += 1;
        Deferred.doneUnsafe(received === 1 ? requested : forced, Effect.void);
      };
      process.prependListener("SIGINT", onSignal);
      process.prependListener("SIGTERM", onSignal);
      return onSignal;
    }),
    (onSignal) =>
      Effect.sync(() => {
        process.removeListener("SIGINT", onSignal);
        process.removeListener("SIGTERM", onSignal);
      }),
  );

/**
 * Runs `startup` and its work, and on shutdown drains them within `deadline` before runtime
 * resources close. Reads `deadline` when the drain starts.
 */
export const withGracefulShutdown = <A, E, R, E2, R2>(
  startup: Effect.Effect<
    {
      readonly running: Effect.Effect<A, E, R>;
      readonly drain: Effect.Effect<void>;
    },
    E2,
    R2
  >,
  requested: Deferred.Deferred<void>,
  deadline: Effect.Effect<Duration.Duration>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const forced = yield* Deferred.make<void>();
      yield* observeSignals(requested, forced);
      // Acquired before the forks, so their shutdown completes while runtime resources (database,
      // executor, HTTP) are still available.
      const runtimeScope = yield* Effect.acquireRelease(Scope.make(), (scope, exit) =>
        Scope.close(scope, exit),
      );
      const started = yield* Effect.forkScoped(Scope.provide(startup, runtimeScope));
      const running = yield* Effect.forkScoped(
        Fiber.join(started).pipe(
          Effect.flatMap(({ running }) =>
            Deferred.isDone(requested).pipe(
              Effect.flatMap((stopped) =>
                stopped ? Effect.never : Scope.provide(running, runtimeScope),
              ),
            ),
          ),
        ),
      );
      return yield* Fiber.join(running).pipe(
        Effect.onInterrupt(() =>
          Effect.gen(function* () {
            yield* Deferred.succeed(requested, undefined);
            const limit = yield* deadline;
            yield* Effect.logInfo("Orchestrator shutdown started", {
              deadlineMilliseconds: Duration.toMillis(limit),
            });
            const stopping = yield* Effect.forkScoped(
              Fiber.interrupt(running).pipe(Effect.interruptible),
              { startImmediately: true },
            );
            const drain = Fiber.join(started).pipe(
              Effect.matchEffect({
                onFailure: (error) =>
                  Effect.logWarning("Runtime startup failed during shutdown", { error }),
                onSuccess: ({ drain }) => drain,
              }),
            );
            // Finalizers are uninterruptible; raced waits must remain
            // interruptible so the losing drain or signal wait can be stopped.
            const outcome = yield* Effect.raceFirst(
              Effect.all([drain, Fiber.join(stopping)], { concurrency: "unbounded" }).pipe(
                // An infinite deadline never elapses; only the second signal ends the drain.
                Effect.timeoutOption(limit),
                Effect.map((result) =>
                  Option.isSome(result) ? ("drained" as const) : ("deadline" as const),
                ),
                Effect.interruptible,
              ),
              Deferred.await(forced).pipe(Effect.as("forced" as const), Effect.interruptible),
            );
            if (outcome === "drained") {
              yield* Effect.logInfo("Orchestrator exiting after graceful drain");
            } else {
              yield* Effect.logWarning(
                "Orchestrator stopping before drain completed; unfinished Attempts will recover on restart",
                { reason: outcome },
              );
              // Cancel Attempts now, even if a trigger's finalizer is slow.
              yield* Effect.all(
                [Fiber.interrupt(started), Scope.close(runtimeScope, Exit.interrupt())],
                { concurrency: "unbounded" },
              );
            }
          }),
        ),
      );
    }),
  );
