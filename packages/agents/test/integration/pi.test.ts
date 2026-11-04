import { NodeServices } from "@effect/platform-node";
import { describe, it } from "@effect/vitest";
import { BrainSpec, ModelId } from "@usine/core/agent/brain";
import { Config, Effect, Schema, Layer } from "effect";
import { PiChildBackend } from "../../src/runtime.ts";
import { piChildBackendLayer, piSdkLive } from "../../src/pi/pi.ts";
import { steeringContract, interruptionContract } from "./contract.ts";

const brain = Effect.gen(function* () {
  const decodedValue2 = yield* Config.String("USINE_PI_INTEGRATION_MODEL");
  const decodedValue1 = yield* Schema.decodeEffect(ModelId)(decodedValue2);
  return BrainSpec.make({
    harness: "pi",
    model: decodedValue1,
    effort: "low",
  });
});

describe("Pi child live contract", () => {
  it.live(
    "applies guidance during an active command and records the result",
    () =>
      Effect.gen(function* () {
        const fixtureBrain = yield* brain;
        const piChildBackend = yield* PiChildBackend;

        return yield* steeringContract(piChildBackend, fixtureBrain);
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
        const fixtureBrain = yield* brain;
        const piChildBackend = yield* PiChildBackend;

        return yield* interruptionContract(piChildBackend, fixtureBrain);
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
