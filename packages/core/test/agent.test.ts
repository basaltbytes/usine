import { describe, expect, it } from "@effect/vitest";
import { Effect, Option, Schema } from "effect";
import {
  Agent,
  AgentPersona,
  resolveParentEffort,
  AgentName,
  DecisionBrain,
  resolveCoordinator,
} from "../src/agent/agent.ts";
import { Harness, BrainSpec, ModelId } from "../src/agent/brain.ts";

describe("Agent brain specs", () => {
  it("resolves the parent effort from the roster, then the instance, then the child brain", () => {
    const base = {
      name: AgentName.make("developer"),
      brain: BrainSpec.make({
        harness: Harness.make("codex"),
        model: ModelId.make("gpt-5.6-sol"),
        effort: "xhigh",
      }),
      parentModel: Option.none(),
      persona: AgentPersona.make("Implement the issue."),
    } as const;
    const inherited = Agent.make({ ...base, parentEffort: Option.none() });
    const overridden = Agent.make({ ...base, parentEffort: Option.some("low") });

    expect(resolveParentEffort(inherited, Option.none())).toBe("xhigh");
    expect(resolveParentEffort(inherited, Option.some("medium"))).toBe("medium");
    expect(resolveParentEffort(overridden, Option.some("medium"))).toBe("low");
  });

  it.effect("decodes a stored Agent without a parent effort as inheriting", () =>
    Effect.gen(function* () {
      const stored = yield* Schema.decodeEffect(Agent)({
        name: "developer",
        brain: { harness: Harness.make("codex"), model: "gpt-5.6-sol", effort: "xhigh" },
        parentModel: null,
        persona: "Implement the issue.",
      });
      expect(Option.isNone(stored.parentEffort)).toBe(true);
      expect(Option.isNone(stored.coordinator)).toBe(true);
      expect(Option.isNone(stored.decision)).toBe(true);
      const encoded = yield* Schema.encodeEffect(Agent)(stored);
      expect(["parentEffort", "coordinator", "decision"].filter((key) => key in encoded)).toEqual(
        [],
      );
    }),
  );

  it.effect("uses the Agent's coordinator before the instance setting", () =>
    Effect.gen(function* () {
      const base = {
        name: AgentName.make("developer"),
        brain: BrainSpec.make({
          harness: Harness.make("codex"),
          model: ModelId.make("gpt-5.6-sol"),
          effort: "xhigh",
        }),
        parentModel: Option.none(),
        parentEffort: Option.none(),
        persona: AgentPersona.make("Implement the issue."),
      } as const;
      const inherited = Agent.make(base);
      const overridden = Agent.make({
        ...base,
        coordinator: Option.some("events"),
        decision: Option.some(DecisionBrain.make({ model: ModelId.make("gpt-6"), effort: "low" })),
      });

      expect(resolveCoordinator(inherited, "events")).toBe("events");
      expect(resolveCoordinator(overridden, "session")).toBe("events");
      const encoded = yield* Schema.encodeEffect(Agent)(overridden);
      const decoded = yield* Schema.decodeEffect(Agent)(encoded);
      expect(decoded).toEqual(overridden);
    }),
  );
});
