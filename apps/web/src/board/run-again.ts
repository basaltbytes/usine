import { type MutationState, useMutationState } from "@tanstack/react-query";
import type { ItemKey } from "@usine/core/item";
import type { RunId } from "@usine/core/run";
import type { RunAgainResult } from "@usine/engine/engine";
import type { RunView } from "@usine/orchestrator/operator";
import { unchangedRunAgain, useRunAgain } from "../run-actions.ts";

/** The state of a Task's latest Run again request, and a function to send one. */
export interface CardRunAgain {
  /** Whether the latest request is in flight. */
  readonly isPending: boolean;
  /** The response to the latest request: the new Run, or the cycle budget Ask that blocked it. */
  readonly data: RunAgainResult | undefined;
  /** The error of the latest request, or `null` if it did not fail. */
  readonly error: Error | null;
  /** Runs `run` again with the same task and Agent. */
  readonly send: (run: RunView) => void;
}

const cardRunAgainKey = (itemKey: ItemKey) => ["run-again", "board-card", itemKey] as const;

/**
 * Returns the Run again state for the card of the Task with `itemKey`, read from the mutation cache
 * so it survives the card remounting after a lane change. On a `Claimed` response, calls `openRun`.
 */
export const useCardRunAgain = (
  itemKey: ItemKey,
  openRun: (runId: RunId) => void,
): CardRunAgain => {
  const mutationKey = cardRunAgainKey(itemKey);
  const again = useRunAgain({ mutationKey, onClaimed: openRun });
  // The mutation cache returns this key's requests oldest first, including an earlier mount's.
  const latest = useMutationState<MutationState<RunAgainResult>>({
    filters: { mutationKey, exact: true },
    select: ({ state }) => state,
  }).at(-1);
  return {
    isPending: latest?.status === "pending",
    data: latest?.data,
    error: latest?.error ?? null,
    send: (run) => again.mutate(unchangedRunAgain(run)),
  };
};
