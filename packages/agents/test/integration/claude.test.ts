import { NodeServices } from "@effect/platform-node";
import { describe, it } from "@effect/vitest";
import { BrainSpec, ModelId } from "@usine/core/agent/brain";
import { Effect, type FileSystem, Layer, type Path, Schema } from "effect";
import { ClaudeChildBackend, ClaudeLoginLock } from "../../src/runtime.ts";
import { claudeChildBackendLayer, claudeSdkLive } from "../../src/pi/claude.ts";
import { interruptionContract, localHost, shimHost, steeringContract } from "./contract.ts";

const brain = new BrainSpec({
  harness: "claude",
  model: Schema.decodeUnknownSync(ModelId)(process.env.USINE_CLAUDE_INTEGRATION_MODEL),
  effort: "low",
});

// Each contract runs one child at a time, so no launch needs to wait for the Worker's login.
const noLoginLock = Layer.succeed(ClaudeLoginLock)({ withLock: () => (effect) => effect });

const live = <A, E>(
  effect: Effect.Effect<A, E, ClaudeChildBackend | FileSystem.FileSystem | Path.Path>,
) =>
  effect.pipe(
    Effect.provide(claudeChildBackendLayer),
    Effect.provide(claudeSdkLive),
    Effect.provide(noLoginLock),
    Effect.provide(NodeServices.layer),
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
            return yield* steeringContract(yield* ClaudeChildBackend, brain, child);
          }),
        ),
      210_000,
    );

    it.live(
      `interrupts an active command and settles the session ${name}`,
      () =>
        live(
          Effect.gen(function* () {
            return yield* interruptionContract(yield* ClaudeChildBackend, brain, child);
          }),
        ),
      150_000,
    );
  }
});
