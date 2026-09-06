import { NodeRuntime } from "@effect/platform-node";
import { Console, Deferred, Duration, Effect, Fiber } from "effect";
import { withGracefulShutdown } from "../../src/shutdown.ts";

const mode = process.argv[2];
const duringStartup = mode.startsWith("startup");
const finishes = mode === "complete" || mode === "startup";
const forced = mode === "force" || mode === "startup-force" || mode === "slow-cleanup";
const deadline = mode === "deadline" || mode === "startup-deadline";

NodeRuntime.runMain(
  Effect.gen(function* () {
    const requested = yield* Deferred.make();
    const startup = Effect.gen(function* () {
      const attemptReady = yield* Deferred.make();
      const work = finishes
        ? Effect.sleep("80 millis").pipe(Effect.andThen(Console.log("attempt completed")))
        : Effect.never;
      const attempt = yield* Effect.forkScoped(
        Deferred.succeed(attemptReady, undefined).pipe(
          Effect.andThen(work),
          Effect.onInterrupt(() => Console.log("attempt interrupted")),
        ),
      );
      // The interruption observer must be installed before real signals can arrive.
      yield* Deferred.await(attemptReady);
      setTimeout(() => process.kill(process.pid, "SIGTERM"), 10);
      if (forced) setTimeout(() => process.kill(process.pid, "SIGINT"), 25);
      if (duringStartup) yield* Effect.sleep("120 millis");
      yield* Console.log("startup completed");
      return {
        drain: Fiber.join(attempt),
        running: Console.log("triggers started").pipe(
          Effect.andThen(Effect.never),
          Effect.onInterrupt(() =>
            Effect.gen(function* () {
              if (!(yield* Deferred.isDone(requested)))
                yield* Console.log("ERROR admission still open");
              yield* Console.log("trigger cleanup started");
              if (mode === "slow-cleanup") yield* Effect.sleep("150 millis");
              yield* Console.log("trigger cleanup completed");
            }),
          ),
        ),
      };
    });
    yield* withGracefulShutdown(startup, requested, Duration.millis(deadline ? 20 : 2_000));
  }),
);
