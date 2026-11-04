import { Crypto, Config, Effect, type FileSystem, Layer, type Path, Schema } from "effect";
import { NodeServices } from "@effect/platform-node";
import { describe, it } from "@effect/vitest";
import { BrainSpec, ModelId } from "@usine/core/agent/brain";

import { ClaudeChildBackend, ClaudeLoginLock } from "../../src/runtime.ts";
import { claudeChildBackendLayer, claudeSdkLive } from "../../src/harness/claude/claude.ts";
import { interruptionContract, localHost, shimHost, steeringContract } from "./contract.ts";

const brain = Effect.gen(function* () {
  const decodedValue2 = yield* Config.String("USINE_CLAUDE_INTEGRATION_MODEL");
  const decodedValue1 = yield* Schema.decodeEffect(ModelId)(decodedValue2);
  return BrainSpec.make({
    harness: "claude",
    model: decodedValue1,
    effort: "low",
  });
});

// Contracts run one child at a time, so launches skip the Worker login lock.
const noLoginLock = Layer.succeed(ClaudeLoginLock)({ withLock: () => (effect) => effect });

const live = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    ClaudeChildBackend | FileSystem.FileSystem | Path.Path | Crypto.Crypto
  >,
) =>
  effect.pipe(
    Effect.provide(
      claudeChildBackendLayer.pipe(
        Layer.provideMerge(claudeSdkLive),
        Layer.provideMerge(noLoginLock),
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  );

describe("Claude child live contract", () => {
  for (const [name, child] of [
    ["on this machine", localHost],
    ["over the SSH shim", shimHost],
  ] as const) {
    it.live(
      `applies guidance during an active command and records the result ${name}`,
      () =>
        live(
          Effect.gen(function* () {
            const fixtureBrain = yield* brain;
            const claudeChildBackend = yield* ClaudeChildBackend;

            return yield* steeringContract(claudeChildBackend, fixtureBrain, child);
          }),
        ),
      210_000,
    );

    it.live(
      `interrupts an active command and settles the session ${name}`,
      () =>
        live(
          Effect.gen(function* () {
            const fixtureBrain = yield* brain;
            const claudeChildBackend = yield* ClaudeChildBackend;

            return yield* interruptionContract(claudeChildBackend, fixtureBrain, child);
          }),
        ),
      150_000,
    );
  }
});
