import { assert, describe, it } from "@effect/vitest";
import { UsineConfig } from "@usine/config/factory";
import { Executor, ExecutorOperationError } from "@usine/executor";
import { Effect, Layer, Schema } from "effect";
import { stepExecutorLayer } from "../src/scheduler.ts";
import { fixedConfigLayer } from "./support/current-instance.ts";

const unused = () => Effect.die("unused");

describe("Worker scheduler startup", () => {
  it.effect("names the Worker when its preflight fails on an operation", () =>
    Effect.gen(function* () {
      const executor = Layer.succeed(Executor)({
        kind: "local",
        recover: unused,
        isLive: unused,
        outcome: unused,
        preflight: () =>
          Effect.fail(
            new ExecutorOperationError({
              operation: "preflight",
              message: "The harness probe timed out",
              cause: new Error("timeout"),
            }),
          ),
        prepare: unused,
        cancel: unused,
        intervene: unused,
      });
      const config = Schema.decodeUnknownSync(UsineConfig)({ version: 1, repos: [] });
      const failure = yield* Layer.build(
        stepExecutorLayer(config, []).pipe(
          Layer.provide(executor),
          Layer.provide(fixedConfigLayer(config)),
        ),
      ).pipe(Effect.flip, Effect.scoped);
      assert(failure._tag === "ExecutorOperationError", failure._tag);
      assert.strictEqual(failure.operation, "preflight");
      assert.strictEqual(failure.message, "Worker local: The harness probe timed out");
    }),
  );
});
