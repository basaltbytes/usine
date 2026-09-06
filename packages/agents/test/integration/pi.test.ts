import { NodeServices } from "@effect/platform-node";
import { describe, it } from "@effect/vitest";
import { BrainSpec, ModelId } from "@usine/core/agent/brain";
import { Effect, Schema } from "effect";
import { PiChildBackend } from "../../src/runtime.ts";
import { piChildBackendLayer, piSdkLive } from "../../src/pi/pi.ts";
import { steeringContract, interruptionContract } from "./contract.ts";

const brain = new BrainSpec({
  harness: "pi",
  model: Schema.decodeUnknownSync(ModelId)(process.env.USINE_PI_INTEGRATION_MODEL),
  effort: "low",
});

describe("Pi child live contract", () => {
  it.live(
    "applies guidance during an active command and records the result",
    () =>
      Effect.gen(function* () {
        return yield* steeringContract(yield* PiChildBackend, brain);
      }).pipe(
        Effect.provide(piChildBackendLayer),
        Effect.provide(piSdkLive),
        Effect.provide(NodeServices.layer),
      ),
    210_000,
  );

  it.live(
    "interrupts an active command and settles the session",
    () =>
      Effect.gen(function* () {
        return yield* interruptionContract(yield* PiChildBackend, brain);
      }).pipe(
        Effect.provide(piChildBackendLayer),
        Effect.provide(piSdkLive),
        Effect.provide(NodeServices.layer),
      ),
    150_000,
  );
});
