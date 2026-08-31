import { assert, describe, it } from "@effect/vitest";
import { AttemptChannel, Repository } from "@usine/core";
import { Agent } from "@usine/core";
import { assembleChildPrompt, assemblePrompt, githubSignature } from "../src/index.ts";

describe("assemblePrompt", () => {
  it("prepends the repository and payload snapshot before the persona and rendered task", () => {
    const prompt = assemblePrompt({
      repository: Repository.Name.make("acme/demo"),
      payload: { number: 30, title: "Build the agent layer" },
      agent: Agent.Name.make("developer"),
      persona: "You are the factory's implementation agent.",
      task: AttemptChannel.Task.make("Implement issue #30: Build the agent layer"),
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
        "# GitHub identity",
        "",
        "Append this signature to every GitHub comment, issue, or pull request you publish:",
        "— usine agent: developer",
      ].join("\n"),
    );
  });

  it("injects the rostered persona and GitHub signature into child work", () => {
    const name = Agent.Name.make("implementation-agent");
    assert.strictEqual(githubSignature(name), "— usine agent: implementation-agent");
    assert.strictEqual(
      assembleChildPrompt({
        agent: name,
        persona: "You implement focused TypeScript changes.",
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
        "# GitHub identity",
        "",
        "Append this signature to every GitHub comment, issue, or pull request you publish:",
        "— usine agent: implementation-agent",
      ].join("\n"),
    );
  });
});
