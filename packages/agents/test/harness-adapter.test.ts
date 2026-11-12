import { assert, describe, it } from "@effect/vitest";
import { AgentName } from "@usine/core/agent";
import { BrainSpec, Harness, ModelId } from "@usine/core/agent/brain";
import {
  AgentSessionId,
  ChildSession,
  ParentSession,
  RoleName,
  RoleSession,
} from "@usine/core/agent/session";
import { Option } from "effect";
import { parentFields } from "../src/harness/adapter.ts";

const agent = AgentName.make("developer");
const brain = BrainSpec.make({
  harness: Harness.make("claude"),
  model: ModelId.make("model"),
  effort: "off",
});
const parentId = AgentSessionId.make("parent-1");

describe("adapter log fields", () => {
  it("names the parent of every session variant that has one", () => {
    assert.deepStrictEqual(parentFields(ParentSession.make({ id: parentId, agent, brain })), {});
    assert.deepStrictEqual(
      parentFields(
        ChildSession.make({ id: AgentSessionId.make("child-1"), parentId, agent, brain }),
      ),
      { parentSessionId: parentId },
    );
    const role = {
      id: AgentSessionId.make("role-1"),
      role: RoleName.make("decision"),
      agent,
      brain,
    };
    assert.deepStrictEqual(
      parentFields(RoleSession.make({ ...role, parentId: Option.some(parentId) })),
      { parentSessionId: parentId },
    );
    assert.deepStrictEqual(parentFields(RoleSession.make(role)), {});
  });
});
