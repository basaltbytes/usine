import { assert, describe, it } from "@effect/vitest";
import { BrainSpec, ModelId } from "@usine/core/agent/brain";
import {
  AgentSessionId,
  ChildSession,
  ChildSessionBudget,
  ChildSessionCount,
  ParentSession,
} from "@usine/core/agent/session";
import { AgentName } from "@usine/core/agent";
import { Option, Schema } from "effect";
import { RemoteShell } from "../src/child-host.ts";
import {
  AgentResultError,
  ChildRequest,
  ChildSessionBudgetExceededError,
  PoolUnavailableError,
  SessionOperationError,
  toAttemptFailure,
  UnknownModelError,
  UnsupportedEffortError,
  WorkingDirectory,
} from "../src/runtime.ts";

describe("agent runtime contract", () => {
  it("round-trips one explicitly first-level child request", () => {
    const parent = new ParentSession({
      id: AgentSessionId.make("parent-1"),
      agent: AgentName.make("developer"),
      brain: new BrainSpec({
        harness: "pi",
        model: ModelId.make("anthropic/claude-opus-4-6"),
        effort: "high",
      }),
    });
    const request = new ChildRequest({
      environment: { HOME: "/home/worker", PATH: "/usr/bin:/bin" },
      session: new ChildSession({
        id: AgentSessionId.make("child-1"),
        parentId: parent.id,
        agent: parent.agent,
        brain: new BrainSpec({
          harness: "claude",
          model: ModelId.make("claude-sonnet-4-6"),
          effort: "high",
        }),
      }),
      cwd: WorkingDirectory.make("/workspace/repo"),
      host: new RemoteShell({
        ssh: { command: "ssh", args: ["-o", "BatchMode=yes"] },
        sshEnvironment: { HOME: "/home/orchestrator" },
        destination: "worker.exe.xyz",
      }),
      prompt: "Implement the focused change.",
    });

    assert.deepStrictEqual(
      Schema.decodeUnknownSync(ChildRequest)(Schema.encodeSync(ChildRequest)(request)),
      request,
    );
  });

  it("retries SDK trouble as infrastructure and parks everything else on the operator", () => {
    const sessionId = Option.some(AgentSessionId.make("child-1"));
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
        model: ModelId.make("claude-never-existed"),
        message: "Claude does not expose model claude-never-existed",
      }),
      new PoolUnavailableError({
        harness: "pi",
        model: ModelId.make("github-copilot/gpt-5.6-sol"),
        pool: "apiKeys",
        message: "Pi model github-copilot/gpt-5.6-sol must use an API key",
      }),
      new UnsupportedEffortError({
        harness: "codex",
        model: ModelId.make("gpt-5.6-terra"),
        effort: "max",
        message: "Codex model gpt-5.6-terra does not support effort max",
      }),
      new AgentResultError({ sessionId, message: "ran out of turns" }),
    ];
    for (const error of terminal) {
      assert.strictEqual(toAttemptFailure(error)._tag, "AgentFailure");
    }

    const budget = toAttemptFailure(
      new ChildSessionBudgetExceededError({
        maxChildren: ChildSessionBudget.make(4),
        attemptedChildren: ChildSessionCount.make(5),
        message: "Attempt tried to spawn child 5 after reaching its 4-child budget",
      }),
    );
    assert.strictEqual(budget._tag, "ChildSessionBudgetFailure");
    if (budget._tag === "ChildSessionBudgetFailure") {
      assert.strictEqual(budget.maxChildren, 4);
      assert.strictEqual(budget.attemptedChildren, 5);
    }
  });
});
