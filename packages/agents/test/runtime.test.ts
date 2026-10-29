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
import { WorkerName } from "@usine/core/worker";
import { Option, Schema } from "effect";
import { RemoteShell } from "../src/child-host/child-host.ts";
import {
  AgentBlockedError,
  AgentCapacityError,
  harnessFailure,
  reportedOutcome,
  reportText,
  AgentQuestionError,
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
      worker: WorkerName.make("worker-1"),
      machine: Option.none(),
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
        message: 'Claude has no model "claude-never-existed"',
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
        message: 'Codex model "gpt-5.6-terra" doesn\'t support effort max',
      }),
      new AgentResultError({ sessionId, message: "ran out of turns" }),
    ];
    for (const error of terminal) {
      assert.strictEqual(toAttemptFailure(error)._tag, "AgentFailure");
    }

    const blocked = toAttemptFailure(
      new AgentBlockedError({ sessionId, message: "The baseline gate fails on main." }),
    );
    assert.strictEqual(blocked._tag, "BlockedFailure");
    if (blocked._tag === "BlockedFailure") {
      assert.strictEqual(blocked.message, "The baseline gate fails on main.");
    }

    const asked = toAttemptFailure(
      new AgentQuestionError({ sessionId, message: "Which transport should egress use?" }),
    );
    assert.strictEqual(asked._tag, "QuestionFailure");
    if (asked._tag === "QuestionFailure") {
      assert.strictEqual(asked.question, "Which transport should egress use?");
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

it.each([
  ["Selected model is at capacity. Please try a different model.", true],
  ['529 {"error":{"type":"overloaded_error","message":"Overloaded"}}', true],
  ["HTTP 529: Overloaded", true],
  ["529: Overloaded", true],
  ["API Error: 529", true],
  ["HTTP 503: retry after 30 seconds", true],
  ["503: please try again later", true],
  ["HTTP 503: unsupported service", false],
  ["HTTP 429: rate limit", false],
  ["authentication failed", false],
  ["ran out of turns", false],
])("classifies harness refusal %s without retrying task failures", (message, capacity) => {
  const error = harnessFailure(Option.none(), message);
  assert.strictEqual(error instanceof AgentCapacityError, capacity);
  const report = reportedOutcome(Option.none(), reportText(error));
  assert(Option.isSome(report));
  assert.strictEqual(
    toAttemptFailure(report.value)._tag,
    capacity ? "ProviderCapacityFailure" : "AgentFailure",
  );
  assert.strictEqual(report.value.message, message);
});
