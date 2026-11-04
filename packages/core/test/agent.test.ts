import { describe, expect, it } from "@effect/vitest";
import { Effect, Option, Schema } from "effect";
import {
  Agent,
  AgentPersona,
  resolveParentEffort,
  resolveParentModel,
  AgentName,
} from "../src/agent/agent.ts";
import { Harness, BrainSpec, ModelId } from "../src/agent/brain.ts";

const decodeBrain = Schema.decodeUnknownEffect(BrainSpec);

describe("Agent brain specs", () => {
  it.effect("validates usine harness and effort shapes while passing model ids through", () =>
    Effect.gen(function* () {
      const brain = yield* decodeBrain({
        harness: Harness.make("claude"),
        model: "vendor/model-from-tomorrow",
        effort: "xhigh",
      });
      expect(brain.model).toBe("vendor/model-from-tomorrow");
      expect(
        (yield* decodeBrain({ harness: "new-harness", model: "model", effort: "high" })).harness,
      ).toBe("new-harness");
      expect(
        (yield* Effect.flip(
          decodeBrain({ harness: "Not a harness ID", model: "model", effort: "high" }),
        ))._tag,
      ).toBe("SchemaError");
      expect(
        (yield* Effect.flip(
          decodeBrain({ harness: Harness.make("claude"), model: "model", effort: "extreme" }),
        ))._tag,
      ).toBe("SchemaError");
      expect(
        (yield* Effect.flip(
          decodeBrain({ harness: Harness.make("claude"), model: " ", effort: "high" }),
        ))._tag,
      ).toBe("SchemaError");
    }),
  );

  it("uses the roster override before the instance-level parent model", () => {
    const inherited = ModelId.make("anthropic/instance-parent");
    const override = ModelId.make("anthropic/agent-parent");
    const base = {
      name: AgentName.make("developer"),
      brain: BrainSpec.make({
        harness: Harness.make("claude"),
        model: ModelId.make("claude-sonnet-4-6"),
        effort: "high",
      }),
      persona: AgentPersona.make("Implement the issue."),
    } as const;

    const defaulted = Agent.make({
      ...base,
      parentModel: Option.none(),
      parentEffort: Option.none(),
    });
    const overridden = Agent.make({
      ...base,
      parentModel: Option.some(override),
      parentEffort: Option.none(),
    });

    expect(resolveParentModel(defaulted, Option.some(inherited))).toEqual(Option.some(inherited));
    expect(resolveParentModel(overridden, Option.some(inherited))).toEqual(Option.some(override));
  });

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
      expect("parentEffort" in (yield* Schema.encodeEffect(Agent)(stored))).toBe(false);
    }),
  );
});
