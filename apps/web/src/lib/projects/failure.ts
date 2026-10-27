import { isSettledItemState } from "@usine/config/board";
import type { BoardTaskView, RunView } from "@usine/orchestrator/operator";
import { failureMessage } from "~/lib/runs/strings";

/**
 * Returns whether the operator must resolve the failure of `run`, one of the Task's Runs: it's
 * unresolved, and the Run's Item isn't closed or merged.
 */
export const failureNeedsYou = (item: BoardTaskView, run: RunView): boolean =>
  run.canResolveFailure &&
  !item.items.some(({ itemKey, state }) => itemKey === run.itemKey && isSettledItemState(state));

/** A failed Run that needs attention, with the message of its latest failed Attempt. */
export interface RunFailure {
  readonly run: RunView;
  readonly message: string;
}

/** Returns the newest Run whose failure needs attention, or `null`. */
export const failedRun = (item: BoardTaskView): RunFailure | null => {
  const run = [...item.runs].reverse().find((candidate) => failureNeedsYou(item, candidate));
  if (run === undefined) return null;
  const attempts = run.attempts;
  for (let index = attempts.length - 1; index >= 0; index -= 1) {
    const outcome = attempts[index]?.outcome;
    if (outcome?._tag === "Failed") return { run, message: failureMessage(outcome.failure) };
  }
  return null;
};
