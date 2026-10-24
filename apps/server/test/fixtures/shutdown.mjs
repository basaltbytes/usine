import { NodeRuntime } from "@effect/platform-node";
import { Console, Deferred, Duration, Effect, Fiber } from "effect";
import { withGracefulShutdown } from "../../src/shutdown.ts";

const mode = process.argv[2];
const duringStartup = mode.startsWith("startup");
const finishes = mode === "complete" || mode === "startup";
const forced = mode === "force" || mode === "startup-force" || mode === "slow-cleanup";
const deadline = mode === "deadline" || mode === "startup-deadline";

// Sent from a SIGTERM listener, so the second signal always follows the first.
if (forced) process.once("SIGTERM", () => process.kill(process.pid, "SIGINT"));
const terminate = Effect.sync(() => process.kill(process.pid, "SIGTERM"));

NodeRuntime.runMain(
  Effect.gen(function* () {
    const requested = yield* Deferred.make();
    const draining = yield* Deferred.make();
    const interrupted = yield* Deferred.make();
    const startup = Effect.gen(function* () {
      const attemptReady = yield* Deferred.make();
      const work = finishes
        ? Deferred.await(draining).pipe(Effect.andThen(Console.log("attempt completed")))
        : Effect.never;
      const attempt = yield* Effect.forkScoped(
        Deferred.succeed(attemptReady, undefined).pipe(
          Effect.andThen(work),
          Effect.onInterrupt(() =>
            Console.log("attempt interrupted").pipe(
              Effect.andThen(Deferred.succeed(interrupted, undefined)),
            ),
          ),
        ),
      );
      // The interruption observer must be installed before real signals can arrive.
      yield* Deferred.await(attemptReady);
      if (duringStartup) {
        yield* terminate;
        // Only a graceful drain lets startup finish; otherwise shutdown must interrupt it.
        yield* finishes ? Deferred.await(requested) : Effect.never;
      }
      yield* Console.log("startup completed");
      return {
        // The Attempt finishes only once shutdown waits for it.
        drain: Deferred.succeed(draining, undefined).pipe(Effect.andThen(Fiber.join(attempt))),
        running: Console.log("triggers started").pipe(
          Effect.andThen(terminate),
          Effect.andThen(Effect.never),
          Effect.onInterrupt(() =>
            Effect.gen(function* () {
              if (!(yield* Deferred.isDone(requested)))
                yield* Console.log("ERROR admission still open");
              yield* Console.log("trigger cleanup started");
              if (mode === "slow-cleanup") yield* Deferred.await(interrupted);
              yield* Console.log("trigger cleanup completed");
            }),
          ),
        ),
      };
    });
    yield* withGracefulShutdown(
      startup,
      requested,
      Effect.succeed(deadline ? Duration.millis(20) : Duration.infinity),
    );
  }),
);
