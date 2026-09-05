import type { AgentPersona, AgentName } from "@usine/core/agent";
import type { AttemptTask } from "@usine/core/attempt";
import type { RepositoryName } from "@usine/core/repository";
import type { Schema } from "effect";

/** The recorded trigger context, Agent instructions, and effective task presented to the parent. */
export interface PromptParts {
  readonly repository: RepositoryName;
  readonly payload: Schema.Json;
  readonly agent: AgentName;
  readonly persona: AgentPersona;
  readonly task: AttemptTask;
}

/** The Agent's standing instructions and the focused task the parent delegates to a child. */
export interface ChildPromptParts {
  readonly agent: AgentName;
  readonly persona: AgentPersona;
  /** Free text authored by the parent model, not the rendered loop task. */
  readonly task: string;
}

/** The attribution line every GitHub comment or review written by an Agent ends with. */
export const githubSignature = (agent: AgentName): string => `— usine agent: ${agent}`;

/** Builds the parent's instructions from the saved payload, effective task, and Agent persona, including GitHub attribution. */
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

/** Builds a child's instructions from the delegated task and Agent persona, including GitHub attribution. */
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
