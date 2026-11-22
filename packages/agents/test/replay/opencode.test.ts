import { NodeServices } from "@effect/platform-node";
import { describe, it } from "@effect/vitest";
import { Harness } from "@usine/core/agent/brain";
import { Effect } from "effect";
import { assertProvenCapabilities } from "../contract/capabilities.ts";
import { openCodeScenarios, openOpenCodeFixture } from "./opencode.ts";
import { runScenario } from "./scenarios.ts";

describe("recorded OpenCode bridge traffic", () => {
  for (const scenario of openCodeScenarios)
    it.live(
      `opencode: ${scenario}`,
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const fixture = yield* openOpenCodeFixture(scenario, "replay");
            const events = yield* runScenario(scenario, fixture.request, fixture.controls).pipe(
              Effect.provide(fixture.backend),
              fixture.tape.guard,
            );
            assertProvenCapabilities(Harness.make("opencode"), scenario, events);
            yield* fixture.save;
          }),
        ).pipe(Effect.provide(NodeServices.layer), Effect.timeout("15 seconds")),
      20_000,
    );
});
