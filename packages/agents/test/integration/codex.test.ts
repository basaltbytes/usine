import { NodeServices } from "@effect/platform-node";
import { describe, it } from "@effect/vitest";
import { BrainSpec, ModelId } from "@usine/core/agent/brain";
import { Effect, Schema } from "effect";
import { CodexChildBackend } from "../../src/runtime.ts";
import { codexAppServerLive } from "../../src/pi/codex/app-server.ts";
import { codexChildBackendLayer } from "../../src/pi/codex/codex.ts";
import { steeringContract, interruptionContract } from "./contract.ts";

const brain = new BrainSpec({
  harness: "codex",
  model: Schema.decodeUnknownSync(ModelId)(process.env.USINE_CODEX_INTEGRATION_MODEL),
  effort: "low",
});

describe("Codex child live contract", () => {
  it.live(
    "applies guidance during an active command and records the result",
    () =>
      Effect.gen(function* () {
        return yield* steeringContract(yield* CodexChildBackend, brain);
      }).pipe(
        Effect.provide(codexChildBackendLayer),
        Effect.provide(codexAppServerLive),
        Effect.provide(NodeServices.layer),
      ),
    210_000,
  );

  it.live(
    "interrupts an active command and settles the session",
    () =>
      Effect.gen(function* () {
        return yield* interruptionContract(yield* CodexChildBackend, brain);
      }).pipe(
        Effect.provide(codexChildBackendLayer),
        Effect.provide(codexAppServerLive),
        Effect.provide(NodeServices.layer),
      ),
    150_000,
  );
});
