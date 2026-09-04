import { describe, expect, it } from "@effect/vitest";
import { Option, Schema } from "effect";
import {
  Agent,
  AgentPersona,
  resolveParentEffort,
  resolveParentModel,
} from "../src/agent/agent.ts";
import { BrainSpec, ModelId } from "../src/agent/brain.ts";
import { AgentName } from "../src/ids.ts";

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
      name: AgentName.make("developer"),
      brain: new BrainSpec({
        harness: "claude",
        model: ModelId.make("claude-sonnet-4-6"),
        effort: "high",
      }),
      persona: AgentPersona.make("Implement the issue."),
    } as const;

    const defaulted = new Agent({
      ...base,
      parentModel: Option.none(),
      parentEffort: Option.none(),
    });
    const overridden = new Agent({
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
      brain: new BrainSpec({
        harness: "codex",
        model: ModelId.make("gpt-5.6-sol"),
        effort: "xhigh",
      }),
      parentModel: Option.none(),
      persona: AgentPersona.make("Implement the issue."),
    } as const;
    const inherited = new Agent({ ...base, parentEffort: Option.none() });
    const overridden = new Agent({ ...base, parentEffort: Option.some("low") });

    expect(resolveParentEffort(inherited, Option.none())).toBe("xhigh");
    expect(resolveParentEffort(inherited, Option.some("medium"))).toBe("medium");
    expect(resolveParentEffort(overridden, Option.some("medium"))).toBe("low");
  });

  it("decodes a stored Agent without a parent effort as inheriting", () => {
    const stored = Schema.decodeUnknownSync(Agent)({
      name: "developer",
      brain: { harness: "codex", model: "gpt-5.6-sol", effort: "xhigh" },
      parentModel: null,
      persona: "Implement the issue.",
    });
    expect(Option.isNone(stored.parentEffort)).toBe(true);
    expect("parentEffort" in Schema.encodeSync(Agent)(stored)).toBe(false);
  });
});
