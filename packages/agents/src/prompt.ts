import type { Agent, AttemptChannel, Repository } from "@usine/core";
import type { Schema } from "effect";

export interface PromptParts {
  readonly repository: Repository.Name;
  readonly payload: Schema.Json;
  readonly agent?: Agent.Name;
  readonly persona: string;
  readonly task: AttemptChannel.Task;
}

export interface ChildPromptParts {
  readonly agent: Agent.Name;
  readonly persona: string;
  readonly task: string;
}

/** Human-visible attribution required on GitHub content authored by an Agent. */
export const githubSignature = (agent: Agent.Name): string => `— usine agent: ${agent}`;

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
    ...(parts.agent === undefined
      ? []
      : [
          "",
          "# GitHub identity",
          "",
          "Append this signature to every GitHub comment, issue, or pull request you publish:",
          githubSignature(parts.agent),
        ]),
  ].join("\n");

/** Builds the isolated prompt given to a first-level child session. */
export const assembleChildPrompt = (parts: ChildPromptParts): string =>
  [
    "# Agent persona",
    "",
    parts.persona,
    "",
    "# Delegated task",
    "",
    parts.task,
    "",
    "# GitHub identity",
    "",
    "Append this signature to every GitHub comment, issue, or pull request you publish:",
    githubSignature(parts.agent),
  ].join("\n");
