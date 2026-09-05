import { NodeRuntime } from "@effect/platform-node";
import { Console, Duration, Effect, Fiber } from "effect";
import { withGracefulShutdown } from "../../src/shutdown.ts";

const mode = process.argv[2];

NodeRuntime.runMain(
  Effect.scoped(
    Effect.gen(function* () {
      const work =
        mode === "complete"
          ? Effect.sleep("80 millis").pipe(Effect.andThen(Console.log("attempt completed")))
          : Effect.never;
      const attempt = yield* Effect.forkScoped(
        work.pipe(Effect.onInterrupt(() => Console.log("attempt interrupted"))),
      );
      const drain = Effect.gen(function* () {
        if (mode === "force") setTimeout(() => process.kill(process.pid, "SIGINT"), 10);
        yield* Fiber.join(attempt);
      });
      setTimeout(() => process.kill(process.pid, "SIGTERM"), 10);
      yield* withGracefulShutdown(
        Effect.never,
        drain,
        Duration.millis(mode === "deadline" ? 20 : 2_000),
      );
    }),
  ),
);
