import { Schema } from "effect";

/** Durable one-shot requests from the store to the workflow runtime. */
export const WORKFLOW_COMMANDS = ["Approve", "Continue", "Interrupt", "Resume"] as const;

export const WorkflowCommand = Schema.Literals(WORKFLOW_COMMANDS);

export type WorkflowCommand = typeof WorkflowCommand.Type;

/**
 * Replay order after a restart, first delivered first. Interrupt must precede
 * Continue: on a cancel replay the canceled workflow stops before the next
 * queued Event opens, preserving one open Run per Item. The length constraint
 * forces this list to name every command exactly once.
 */
export const WORKFLOW_COMMAND_PRIORITY = [
  "Resume",
  "Interrupt",
  "Continue",
  "Approve",
] as const satisfies ReadonlyArray<WorkflowCommand> & {
  length: (typeof WORKFLOW_COMMANDS)["length"];
};
