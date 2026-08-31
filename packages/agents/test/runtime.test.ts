import { assert, describe, it } from "@effect/vitest";
import { Agent } from "@usine/core";
import { Schema } from "effect";
import { ChildRequest, WorkingDirectory } from "../src/index.ts";

describe("agent runtime contract", () => {
  it("round-trips one explicitly first-level child request", () => {
    const parent = new Agent.ParentSession({
      id: Agent.SessionId.make("parent-1"),
      agent: Agent.Name.make("developer"),
      brain: new Agent.BrainSpec({
        harness: "pi",
        model: Agent.ModelId.make("anthropic/claude-opus-4-6"),
        effort: "high",
      }),
    });
    const request = new ChildRequest({
      session: new Agent.ChildSession({
        id: Agent.SessionId.make("child-1"),
        parentId: parent.id,
        agent: parent.agent,
        brain: new Agent.BrainSpec({
          harness: "claude",
          model: Agent.ModelId.make("claude-sonnet-4-6"),
          effort: "high",
        }),
      }),
      cwd: WorkingDirectory.make("/workspace/repo"),
      prompt: "Implement the focused change.",
    });

    assert.deepStrictEqual(Schema.decodeUnknownSync(ChildRequest)(request), request);
  });
});
