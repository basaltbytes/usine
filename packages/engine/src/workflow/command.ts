import { Schema } from "effect";

/** One-shot requests the store hands to the workflow runtime. */
export const WORKFLOW_COMMANDS = ["Approve", "Continue", "Interrupt", "Resume"] as const;

export const WorkflowCommand = Schema.Literals(WORKFLOW_COMMANDS);

export type WorkflowCommand = typeof WorkflowCommand.Type;

/**
 * Replay order after a restart, first delivered first. Interrupt precedes
 * Continue so a canceled workflow stops before the next queued Event opens,
 * keeping one open Run per Item; the length constraint makes the list name
 * every command exactly once.
 */
export const WORKFLOW_COMMAND_PRIORITY = [
  "Resume",
  "Interrupt",
  "Continue",
  "Approve",
] as const satisfies ReadonlyArray<WorkflowCommand> & {
  length: (typeof WORKFLOW_COMMANDS)["length"];
};
