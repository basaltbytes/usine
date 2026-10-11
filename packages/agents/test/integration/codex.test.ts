import { NodeServices } from "@effect/platform-node";
import { describe, it } from "@effect/vitest";
import { BrainSpec, ModelId } from "@usine/core/agent/brain";
import { Effect, Schema } from "effect";
import { CodexChildBackend } from "../../src/runtime.ts";
import { codexAppServerLive } from "../../src/pi/codex/app-server.ts";
import { codexChildBackendLayer } from "../../src/pi/codex/codex.ts";
import { interruptionContract, localHost, shimHost, steeringContract } from "./contract.ts";

const brain = new BrainSpec({
  harness: "codex",
  model: Schema.decodeUnknownSync(ModelId)(process.env.USINE_CODEX_INTEGRATION_MODEL),
  effort: "low",
});

const live = <A, E>(effect: Effect.Effect<A, E, CodexChildBackend>) =>
  effect.pipe(
    Effect.provide(codexChildBackendLayer),
    Effect.provide(codexAppServerLive),
    Effect.provide(NodeServices.layer),
  );

describe("Codex child live contract", () => {
  for (const [name, child] of [
    ["on this machine", localHost],
    ["over the SSH shim", shimHost],
  ] as const) {
    it.live(
      `applies guidance during an active command and records the result ${name}`,
      () =>
        live(
          Effect.gen(function* () {
            return yield* steeringContract(yield* CodexChildBackend, brain, child);
          }),
        ),
      210_000,
    );

    it.live(
      `interrupts an active command and settles the session ${name}`,
      () =>
        live(
          Effect.gen(function* () {
            return yield* interruptionContract(yield* CodexChildBackend, brain, child);
          }),
        ),
      150_000,
    );
  }
});
