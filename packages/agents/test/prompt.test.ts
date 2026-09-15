import { assert, describe, it } from "@effect/vitest";
import { AgentPersona, AgentName } from "@usine/core/agent";
import { AttemptTask } from "@usine/core/attempt";
import { RepositoryName } from "@usine/core/repository";
import { assembleChildPrompt, assemblePrompt, githubSignature } from "../src/prompt.ts";

describe("assemblePrompt", () => {
  it("prepends the repository and payload snapshot before the persona and rendered task", () => {
    const prompt = assemblePrompt({
      repository: RepositoryName.make("acme/demo"),
      payload: { number: 30, title: "Build the agent layer" },
      agent: AgentName.make("developer"),
      persona: AgentPersona.make("You are the factory's implementation agent."),
      task: AttemptTask.make("Implement issue #30: Build the agent layer"),
    });

    assert.strictEqual(
      prompt,
      [
        "# Run context",
        "",
        "Repository: acme/demo",
        "",
        "Payload snapshot:",
        "```json",
        '{\n  "number": 30,\n  "title": "Build the agent layer"\n}',
        "```",
        "",
        "# Agent persona",
        "",
        "You are the factory's implementation agent.",
        "",
        "# Task",
        "",
        "Implement issue #30: Build the agent layer",
        "",
        "# Task completion",
        "",
        "Run gates, tests, and CI watches in the foreground. If a tool starts background work, wait for its result and finish every dependent step before returning your final answer.",
        "Do not end a turn promising to resume after a background notification. Your final answer returns control to the caller and may end the Attempt and remove its worktree. Push all commits that must survive before returning.",
        "A running command or pending CI check is unfinished work, not a blocker. Keep waiting and complete the task. For a genuine blocker, record the exact blocker on the issue or pull request and report which work remains incomplete.",
        "",
        "# GitHub identity",
        "",
        "All factory Agents use the same GitHub App identity, including the Agent that opened a pull request.",
        "Submit pull request reviews with event COMMENT (gh pr review --comment), never APPROVE or REQUEST_CHANGES. Attach each review to the exact commit you reviewed.",
        "Use the Loop's outcome labels to report findings or a passed review, and remove the opposite outcome label. A passed label does not satisfy GitHub required approvals; the operator provides any independent approval and merges.",
        "Append this signature to every GitHub comment, issue, pull request, or review you publish:",
        "— usine agent: developer",
      ].join("\n"),
    );
  });

  it("injects the rostered persona and GitHub signature into child work", () => {
    const name = AgentName.make("implementation-agent");
    assert.strictEqual(githubSignature(name), "— usine agent: implementation-agent");
    assert.strictEqual(
      assembleChildPrompt({
        agent: name,
        persona: AgentPersona.make("You implement focused TypeScript changes."),
        task: "Add the session interrupt adapter.",
      }),
      [
        "# Agent persona",
        "",
        "You implement focused TypeScript changes.",
        "",
        "# Delegated task",
        "",
        "Add the session interrupt adapter.",
        "",
        "# Task completion",
        "",
        "Run gates, tests, and CI watches in the foreground. If a tool starts background work, wait for its result and finish every dependent step before returning your final answer.",
        "Do not end a turn promising to resume after a background notification. Your final answer returns control to the caller and may end the Attempt and remove its worktree. Push all commits that must survive before returning.",
        "A running command or pending CI check is unfinished work, not a blocker. Keep waiting and complete the task. For a genuine blocker, record the exact blocker on the issue or pull request and report which work remains incomplete.",
        "",
        "# GitHub identity",
        "",
        "All factory Agents use the same GitHub App identity, including the Agent that opened a pull request.",
        "Submit pull request reviews with event COMMENT (gh pr review --comment), never APPROVE or REQUEST_CHANGES. Attach each review to the exact commit you reviewed.",
        "Use the Loop's outcome labels to report findings or a passed review, and remove the opposite outcome label. A passed label does not satisfy GitHub required approvals; the operator provides any independent approval and merges.",
        "Append this signature to every GitHub comment, issue, pull request, or review you publish:",
        "— usine agent: implementation-agent",
      ].join("\n"),
    );
  });
});
