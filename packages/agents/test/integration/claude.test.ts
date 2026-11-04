import { NodeServices } from "@effect/platform-node";
import { describe, it } from "@effect/vitest";
import { BrainSpec, ModelId } from "@usine/core/agent/brain";
import { Effect, type FileSystem, Layer, type Path, Schema } from "effect";
import { ClaudeChildBackend, ClaudeLoginLock } from "../../src/runtime.ts";
import { claudeChildBackendLayer, claudeSdkLive } from "../../src/pi/claude/claude.ts";
import { interruptionContract, localHost, shimHost, steeringContract } from "./contract.ts";

const brain = BrainSpec.make({
  harness: "claude",
  model: Schema.decodeUnknownSync(ModelId)(process.env.USINE_CLAUDE_INTEGRATION_MODEL),
  effort: "low",
});

// Contracts run one child at a time, so launches skip the Worker login lock.
const noLoginLock = Layer.succeed(ClaudeLoginLock)({ withLock: () => (effect) => effect });

const live = <A, E>(
  effect: Effect.Effect<A, E, ClaudeChildBackend | FileSystem.FileSystem | Path.Path>,
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
            const claudeChildBackend = yield* ClaudeChildBackend;
            return yield* steeringContract(claudeChildBackend, brain, child);
          }),
        ),
      210_000,
    );

    it.live(
      `interrupts an active command and settles the session ${name}`,
      () =>
        live(
          Effect.gen(function* () {
            const claudeChildBackend = yield* ClaudeChildBackend;
            return yield* interruptionContract(claudeChildBackend, brain, child);
          }),
        ),
      150_000,
    );
  }
});
