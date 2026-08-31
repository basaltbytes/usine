import { assert, describe, it } from "@effect/vitest";
import { AttemptChannel, Repository } from "@usine/core";
import { assemblePrompt } from "../src/index.ts";

describe("assemblePrompt", () => {
  it("prepends the repository and payload snapshot before the persona and rendered task", () => {
    const prompt = assemblePrompt({
      repository: Repository.Name.make("acme/demo"),
      payload: { number: 30, title: "Build the agent layer" },
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
      ].join("\n"),
    );
  });
});
