import { NodeServices } from "@effect/platform-node";
import { describe, it } from "@effect/vitest";
import { BrainSpec, ModelId } from "@usine/core/agent/brain";
import { Effect, Schema, Layer } from "effect";
import { PiChildBackend } from "../../src/runtime.ts";
import { piChildBackendLayer, piSdkLive } from "../../src/pi/pi.ts";
import { steeringContract, interruptionContract } from "./contract.ts";

const brain = BrainSpec.make({
  harness: "pi",
  model: Schema.decodeUnknownSync(ModelId)(process.env.USINE_PI_INTEGRATION_MODEL),
  effort: "low",
});

describe("Pi child live contract", () => {
  it.live(
    "applies guidance during an active command and records the result",
    () =>
      Effect.gen(function* () {
        const piChildBackend = yield* PiChildBackend;
        return yield* steeringContract(piChildBackend, brain);
      }).pipe(
        Effect.provide(
          piChildBackendLayer.pipe(
            Layer.provideMerge(piSdkLive),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    210_000,
  );

  it.live(
    "interrupts an active command and settles the session",
    () =>
      Effect.gen(function* () {
        const piChildBackend = yield* PiChildBackend;
        return yield* interruptionContract(piChildBackend, brain);
      }).pipe(
        Effect.provide(
          piChildBackendLayer.pipe(
            Layer.provideMerge(piSdkLive),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    150_000,
  );
});
