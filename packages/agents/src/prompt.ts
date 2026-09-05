import type { AgentPersona, AgentName } from "@usine/core/agent";
import type { AttemptTask } from "@usine/core/attempt";
import type { RepositoryName } from "@usine/core/repository";
import type { Schema } from "effect";

export interface PromptParts {
  readonly repository: RepositoryName;
  readonly payload: Schema.Json;
  readonly agent: AgentName;
  readonly persona: AgentPersona;
  readonly task: AttemptTask;
}

export interface ChildPromptParts {
  readonly agent: AgentName;
  readonly persona: AgentPersona;
  /** Free text authored by the parent model, not the rendered loop task. */
  readonly task: string;
}

/** Human-visible attribution required on GitHub content authored by an Agent. */
export const githubSignature = (agent: AgentName): string => `— usine agent: ${agent}`;

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
    "",
    "# GitHub identity",
    "",
    "Append this signature to every GitHub comment, issue, or pull request you publish:",
    githubSignature(parts.agent),
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
