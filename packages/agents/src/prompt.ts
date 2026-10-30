import { githubSignature, type AgentPersona, type AgentName } from "@usine/core/agent";
import type { AttemptTask } from "@usine/core/attempt";
import type { SalvagePushed } from "@usine/core/attempt/salvage";
import type { RepositoryName } from "@usine/core/repository";
import { Option, type Schema } from "effect";
import { BLOCKED_MARKER, QUESTION_MARKER } from "./runtime.ts";

/** The trigger context, agent instructions, and task for the parent prompt. */
export interface PromptParts {
  /** The managed repository named in the parent's run context. */
  readonly repository: RepositoryName;
  /** The trigger payload snapshot, serialized as JSON in the parent prompt. */
  readonly payload: Schema.Json;
  /** The agent name used in the required GitHub content signature (ADR 0011). */
  readonly agent: AgentName;
  /** The agent's standing instructions, included before the task. */
  readonly persona: AgentPersona;
  /** The rendered loop task, including any edit-and-retry replacement (ADR 0018). */
  readonly task: AttemptTask;
  /** The previous attempt's salvage checked out in the workspace, if the run is retrying. */
  readonly resume: Option.Option<SalvagePushed>;
  /** The previous attempt's salvage that conflicts with the current revision and is not in the workspace. */
  readonly conflictingSalvage: Option.Option<SalvagePushed>;
}

/** The agent instructions and delegated task for a child prompt. */
export interface ChildPromptParts {
  /** The agent name used in the required GitHub content signature (ADR 0011). */
  readonly agent: AgentName;
  /** The agent's standing instructions, included before the task. */
  readonly persona: AgentPersona;
  /** Free text written by the parent model, not the rendered loop task. */
  readonly task: string;
}

const completionInstructions: ReadonlyArray<string> = [
  "# Task completion",
  "",
  "Run gates, tests, and CI watches in the foreground. If a tool starts background work, wait for its result and finish every dependent step before returning your final answer.",
  "Do not end a turn promising to resume after a background notification. Your final answer returns control to the caller and may end the Attempt and remove its worktree. Push all commits that must survive before returning.",
  "A running command or pending CI check is unfinished work, not a blocker. Keep waiting and complete the task. For a genuine blocker, record the exact blocker on the issue or pull request and report which work remains incomplete.",
  `For an unresolved blocker, start your final answer with exactly ${BLOCKED_MARKER} on its own line, followed by the exact blocker and incomplete work. This reserved marker reports a failed Attempt. A child's report that starts with the marker fails the Attempt: return it verbatim as your own final answer. Use an ordinary final answer only after completing the task.`,
  `When the work needs a decision that only the operator can make, post the question on the task's issue or pull request when it has one, then start your final answer with exactly ${QUESTION_MARKER} on its own line, followed by the question and the options you see. This reserved marker ends the Attempt and asks the operator; usine does not run this task again on the same Item until the operator answers or the Item changes. Return a child's report that starts with this marker verbatim as your own final answer.`,
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

const resumeLines = (parts: PromptParts): ReadonlyArray<string> => [
  ...Option.match(parts.resume, {
    onNone: () => [],
    onSome: ({ ref, commit }) => [
      `Resumes from: ${ref} at ${commit}, the previous Attempt's unfinished work, checked out at HEAD. Its last commit is an automatic work-in-progress snapshot. Continue from this state instead of starting over.`,
    ],
  }),
  ...Option.match(parts.conflictingSalvage, {
    onNone: () => [],
    onSome: ({ ref, commit }) => [
      `Previous work: ${ref} at ${commit}, the previous Attempt's unfinished work, conflicts with the current revision, so the checkout starts without it. Fetch that branch to reuse parts of it.`,
    ],
  }),
];

/** Returns the parent's instructions, including GitHub attribution. */
export const assemblePrompt = (parts: PromptParts): string =>
  [
    "# Run context",
    "",
    `Repository: ${parts.repository}`,
    ...resumeLines(parts),
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

/** Returns a child's instructions, including GitHub attribution. */
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
