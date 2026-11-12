import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import {
  openFixture,
  openPiFixture,
  piScenarios,
  type Provider,
  recordingModel,
  scenarios,
} from "./fixture.ts";
import { runScenario } from "./scenarios.ts";
import { runToolScenario, toolProviders, toolScenarios } from "../contract/host-tools.ts";

export const recordContracts = (provider: Provider): void => {
  for (const scenario of provider === "pi" ? piScenarios : scenarios)
    it.live.skipIf(recordingModel(provider) === undefined)(
      `records ${provider}: ${scenario}`,
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const fixture =
              provider === "pi"
                ? yield* openPiFixture(scenario, "record")
                : yield* openFixture(provider, scenario, "record");
            yield* runScenario(scenario, fixture.request, fixture.controls).pipe(
              Effect.provide(fixture.backend),
              fixture.tape.guard,
            );
            yield* fixture.save;
          }),
        ).pipe(Effect.provide(NodeServices.layer)),
      240_000,
    );
  for (const tools of toolProviders)
    if (tools === provider)
      for (const scenario of toolScenarios)
        it.live.skipIf(recordingModel(provider) === undefined)(
          `records ${provider}: ${scenario}`,
          () =>
            runToolScenario(tools, scenario, "record").pipe(
              Effect.scoped,
              Effect.provide(NodeServices.layer),
            ),
          240_000,
        );
};
