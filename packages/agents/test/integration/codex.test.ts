import { Crypto, Config, Effect, type FileSystem, type Path, Schema, Layer } from "effect";
import { NodeServices } from "@effect/platform-node";
import { describe, it } from "@effect/vitest";
import { Harness, BrainSpec, ModelId } from "@usine/core/agent/brain";

import { ChildBackend } from "../../src/runtime.ts";
import { codexAppServerLive } from "../../src/harness/codex/app-server.ts";
import { codexChildLayer } from "../../src/harness/codex/codex.ts";
import { interruptionContract, localHost, shimHost, steeringContract } from "./contract.ts";

const brain = Effect.gen(function* () {
  const decodedValue2 = yield* Config.String("USINE_CODEX_INTEGRATION_MODEL");
  const decodedValue1 = yield* Schema.decodeEffect(ModelId)(decodedValue2);
  return BrainSpec.make({
    harness: Harness.make("codex"),
    model: decodedValue1,
    effort: "low",
  });
});

const live = <A, E>(
  effect: Effect.Effect<A, E, ChildBackend | FileSystem.FileSystem | Path.Path | Crypto.Crypto>,
) =>
  effect.pipe(
    Effect.provide(
      codexChildLayer.pipe(
        Layer.provideMerge(codexAppServerLive),
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
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
            const fixtureBrain = yield* brain;
            const codexChildBackend = yield* ChildBackend;

            return yield* steeringContract(codexChildBackend, fixtureBrain, child);
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
            const codexChildBackend = yield* ChildBackend;

            return yield* interruptionContract(codexChildBackend, fixtureBrain, child);
          }),
        ),
      150_000,
    );
  }
});
