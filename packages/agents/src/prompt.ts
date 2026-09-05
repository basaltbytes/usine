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

const githubInstructions = (agent: AgentName): ReadonlyArray<string> => [
  "# GitHub identity",
  "",
  "All factory Agents use the same GitHub App identity, including the Agent that opened a pull request.",
  "Submit pull request reviews with event COMMENT (gh pr review --comment), never APPROVE or REQUEST_CHANGES. Attach each review to the exact commit you reviewed.",
  "Use the Loop's outcome labels to report findings or a passed review, and remove the opposite outcome label. A passed label does not satisfy GitHub required approvals; the operator provides any independent approval and merges.",
  "Append this signature to every GitHub comment, issue, pull request, or review you publish:",
  githubSignature(agent),
];

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
    ...githubInstructions(parts.agent),
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
    ...githubInstructions(parts.agent),
  ].join("\n");
