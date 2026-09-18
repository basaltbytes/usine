import type { AgentPersona, AgentName } from "@usine/core/agent";
import type { AttemptTask } from "@usine/core/attempt";
import type { RepositoryName } from "@usine/core/repository";
import type { Schema } from "effect";
import { BLOCKED_MARKER } from "./runtime.ts";

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

const completionInstructions: ReadonlyArray<string> = [
  "# Task completion",
  "",
  "Run gates, tests, and CI watches in the foreground. If a tool starts background work, wait for its result and finish every dependent step before returning your final answer.",
  "Do not end a turn promising to resume after a background notification. Your final answer returns control to the caller and may end the Attempt and remove its worktree. Push all commits that must survive before returning.",
  "A running command or pending CI check is unfinished work, not a blocker. Keep waiting and complete the task. For a genuine blocker, record the exact blocker on the issue or pull request and report which work remains incomplete.",
  `For an unresolved blocker, start your final answer with exactly ${BLOCKED_MARKER} on its own line, followed by the exact blocker and incomplete work. This reserved marker reports a failed Attempt. A child's report that starts with the marker fails the Attempt: return it verbatim as your own final answer. Use an ordinary final answer only after completing the task.`,
];

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
    ...completionInstructions,
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
    ...completionInstructions,
    "",
    ...githubInstructions(parts.agent),
  ].join("\n");
