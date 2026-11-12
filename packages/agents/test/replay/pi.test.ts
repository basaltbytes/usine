import { NodeServices } from "@effect/platform-node";
import { describe, it } from "@effect/vitest";
import { Harness } from "@usine/core/agent/brain";
import { Effect } from "effect";
import { assertProvenCapabilities } from "../contract/capabilities.ts";
import { openPiFixture, piScenarios } from "./fixture.ts";
import { runScenario } from "./scenarios.ts";

describe("recorded Pi provider streams", () => {
  for (const scenario of piScenarios)
    it.live(
      `pi: ${scenario}`,
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const fixture = yield* openPiFixture(scenario, "replay");
            const events = yield* runScenario(scenario, fixture.request, fixture.controls).pipe(
              Effect.provide(fixture.backend),
              fixture.tape.guard,
            );
            assertProvenCapabilities(Harness.make("pi"), scenario, events);
            yield* fixture.save;
          }),
        ).pipe(Effect.provide(NodeServices.layer), Effect.timeout("15 seconds")),
      20_000,
    );
});
