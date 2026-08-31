import type { AttemptChannel, Repository } from "@usine/core";
import type { Schema } from "effect";

export interface PromptParts {
  readonly repository: Repository.Name;
  readonly payload: Schema.JsonObject;
  readonly persona: string;
  readonly task: AttemptChannel.Task;
}

/** Builds the complete parent prompt from immutable run context. */
export const assemblePrompt = (parts: PromptParts): string =>
  [
    "# Run context",
    "",
    `Repository: ${parts.repository}`,
    "",
    "Payload snapshot:",
    "```json",
    JSON.stringify(parts.payload, undefined, 2),
    "```",
    "",
    "# Agent persona",
    "",
    parts.persona,
    "",
    "# Task",
    "",
    parts.task,
  ].join("\n");
