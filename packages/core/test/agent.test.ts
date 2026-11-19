import { describe, expect, it } from "@effect/vitest";
import { Effect, Option, Schema } from "effect";
import { Agent, DecisionBrain } from "../src/agent/agent.ts";
import { ModelId } from "../src/agent/brain.ts";

describe("Agent", () => {
  it.effect("decodes a stored Agent that has the removed parent and coordinator keys", () =>
    Effect.gen(function* () {
      // Runs, queued Events, and RunSpecs that earlier versions stored keep these keys.
      const stored = yield* Schema.decodeUnknownEffect(Agent)({
        name: "developer",
        brain: { harness: "codex", model: "gpt-5.6-sol", effort: "xhigh" },
        parentModel: "openai-codex/gpt-5.6-terra",
        parentEffort: "high",
        coordinator: "session",
        decision: { model: "gpt-5.6-terra", effort: "low" },
        persona: "Implement the issue.",
      });
      expect(stored.decision).toEqual(
        Option.some(DecisionBrain.make({ model: ModelId.make("gpt-5.6-terra"), effort: "low" })),
      );
    }),
  );
});
