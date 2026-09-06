import { assert, describe, it } from "@effect/vitest";
import { BrainSpec, ModelId } from "@usine/core/agent/brain";
import { WorkerName } from "@usine/core/worker";
import { Deferred, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { ExecutorOperationError } from "../src/executor.ts";
import { verifyHarnesses } from "../src/harness-preflight.ts";

const worker = WorkerName.make("remote-one");
const brains = [new BrainSpec({ harness: "claude", model: ModelId.make("sonnet"), effort: "low" })];
const runHost = { command: "usine-run-host", args: [] };

describe("harness preflight transport", () => {
  it.effect("preserves an unreachable Worker's infrastructure error for retry", () =>
    Effect.gen(function* () {
      const disconnected = new ExecutorOperationError({
        operation: "preflight",
        message: "SSH connection reset",
        cause: new Error("connection reset"),
      });
      const error = yield* verifyHarnesses(worker, brains, runHost, () => disconnected).pipe(
        Effect.flip,
      );
      assert.strictEqual(error, disconnected);
    }),
  );

  it.effect("cancels a stalled probe and keeps its timeout retryable", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      let closed = false;
      const pending = yield* verifyHarnesses(worker, brains, runHost, () =>
        Effect.scoped(
          Effect.addFinalizer(() =>
            Effect.sync(() => {
              closed = true;
            }),
          ).pipe(
            Effect.andThen(Deferred.succeed(started, undefined)),
            Effect.andThen(Effect.never),
          ),
        ),
      ).pipe(Effect.flip, Effect.forkChild);
      yield* Deferred.await(started);
      yield* TestClock.adjust("75 seconds");
      assert.strictEqual((yield* Fiber.join(pending))._tag, "ExecutorOperationError");
      assert(closed, "the timed-out probe must release its process scope");
    }),
  );
});
