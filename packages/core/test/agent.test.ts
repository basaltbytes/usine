import { describe, expect, it } from "@effect/vitest";
import { Option, Schema } from "effect";
import { Agent, BrainSpec, ModelId, Name, Persona, resolveParentModel } from "../src/agent.ts";

const decodeBrain = Schema.decodeUnknownSync(BrainSpec);

describe("Agent brain specs", () => {
  it("validates usine harness and effort shapes while passing model ids through", () => {
    const brain = decodeBrain({
      harness: "claude",
      model: "vendor/model-from-tomorrow",
      effort: "xhigh",
    });
    expect(brain.model).toBe("vendor/model-from-tomorrow");
    expect(() => decodeBrain({ harness: "unknown", model: "model", effort: "high" })).toThrow();
    expect(() => decodeBrain({ harness: "claude", model: "model", effort: "extreme" })).toThrow();
    expect(() => decodeBrain({ harness: "claude", model: " ", effort: "high" })).toThrow();
  });

  it("uses the roster override before the instance-level parent model", () => {
    const inherited = ModelId.make("anthropic/instance-parent");
    const override = ModelId.make("anthropic/agent-parent");
    const base = {
      name: Name.make("developer"),
      harness: "claude",
      model: ModelId.make("claude-sonnet-4-6"),
      effort: "high",
      persona: Persona.make("Implement the issue."),
    } as const;

    const defaulted = new Agent({ ...base, parentModel: Option.none() });
    const overridden = new Agent({ ...base, parentModel: Option.some(override) });

    expect(resolveParentModel(defaulted, Option.some(inherited))).toEqual(Option.some(inherited));
    expect(resolveParentModel(overridden, Option.some(inherited))).toEqual(Option.some(override));
  });
});
