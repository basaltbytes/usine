import { NodeRuntime } from "@effect/platform-node";
import { Console, Deferred, Effect, Ref } from "effect";
import { reloadOnHangup } from "../../src/reload-signal.ts";

NodeRuntime.runMain(
  Effect.scoped(
    Effect.gen(function* () {
      const count = yield* Ref.make(0);
      const done = [yield* Deferred.make(), yield* Deferred.make()];
      const reload = Effect.gen(function* () {
        const reloads = yield* Ref.updateAndGet(count, (value) => value + 1);
        yield* Console.log(`reload ${reloads}`);
        yield* Deferred.succeed(done[reloads - 1], undefined);
        // The first reload is rejected; the second must still run.
        if (reloads === 1) return yield* Effect.fail({ _tag: "FactoryConfigError" });
      });
      yield* reloadOnHangup({ get: Effect.die("unused"), reload });
      process.kill(process.pid, "SIGHUP");
      yield* Deferred.await(done[0]);
      process.kill(process.pid, "SIGHUP");
      yield* Deferred.await(done[1]);
      yield* Console.log("still running");
    }),
  ),
);
