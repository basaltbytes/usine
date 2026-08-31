import { assert, describe, it } from "@effect/vitest";
import { Agent } from "@usine/core";
import { Option, Schema } from "effect";
import {
  AgentResultError,
  ChildRequest,
  PoolUnavailableError,
  SessionOperationError,
  toAttemptFailure,
  UnknownModelError,
  WorkingDirectory,
} from "../src/index.ts";

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

  it("retries SDK trouble as infrastructure and parks everything else on the operator", () => {
    const sessionId = Option.some(Agent.SessionId.make("child-1"));
    const infra = toAttemptFailure(
      new SessionOperationError({
        operation: "stream",
        sessionId,
        message: "Claude output stream failed",
        cause: new Error("socket closed"),
      }),
    );
    assert.strictEqual(infra._tag, "InfraFailure");

    const terminal = [
      new UnknownModelError({
        harness: "claude",
        model: Agent.ModelId.make("claude-never-existed"),
        message: "Claude does not expose model claude-never-existed",
      }),
      new PoolUnavailableError({
        harness: "pi",
        model: Agent.ModelId.make("openai-codex/gpt-5.6-sol"),
        pool: "apiKeys",
        message: "Pi model openai-codex/gpt-5.6-sol must use an API key",
      }),
      new AgentResultError({ sessionId, message: "ran out of turns" }),
    ];
    for (const error of terminal) {
      assert.strictEqual(toAttemptFailure(error)._tag, "AgentFailure");
    }
  });
});
