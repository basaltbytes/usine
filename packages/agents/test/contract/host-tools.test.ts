import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { Harness } from "@usine/core/agent/brain";
import { Effect } from "effect";
import { assertProvenCapabilities } from "./capabilities.ts";
import {
  listedName,
  listedTools,
  listsOwnTools,
  NOTE,
  runToolScenario,
  toolProviders,
  toolScenariosOf,
} from "./host-tools.ts";

describe("usine tool sets", () => {
  for (const provider of toolProviders)
    for (const scenario of toolScenariosOf(provider))
      it.live(
        `${provider}: ${scenario}`,
        () =>
          Effect.gen(function* () {
            const { message, events, entries } = yield* runToolScenario(
              provider,
              scenario,
              "replay",
            );
            assert.include(message, NOTE);
            const started = events.flatMap((event) =>
              event._tag === "ToolStarted" ? [event] : [],
            );
            const finished = events.flatMap((event) =>
              event._tag === "ToolFinished" ? [event] : [],
            );
            // Events carry the toolkit's name, without the harness's prefix.
            assert.deepStrictEqual(
              started.map(({ tool }) => tool),
              scenario === "host-tool" ? ["read_note", "read_note"] : ["read_note"],
            );
            assert.deepStrictEqual(
              finished.map(({ tool, isError }) => ({ tool, isError })),
              scenario === "host-tool"
                ? [
                    { tool: "read_note", isError: true },
                    { tool: "read_note", isError: false },
                  ]
                : [{ tool: "read_note", isError: false }],
              "a handler failure reaches the model as a tool error and the session continues",
            );
            assert.strictEqual(events.at(-1)?._tag, "SessionFinished");
            const listed = listedTools(provider, entries);
            assert.isNotEmpty(listed, "the recorded traffic shows the session's tool list");
            for (const tools of listed) {
              if (scenario === "closed-tools")
                assert.deepStrictEqual(tools, [listedName[provider]], "only the given tools");
              else assert.include(tools, listedName[provider]);
              if (scenario === "host-tool" && listsOwnTools.has(provider))
                assert.isAbove(tools.length, 1, "the harness's own tools stay on");
            }
            assertProvenCapabilities(Harness.make(provider), scenario, events);
          }).pipe(Effect.provide(NodeServices.layer), Effect.timeout("15 seconds")),
        20_000,
      );
});
