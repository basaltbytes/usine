import { type MutationState, useMutationState } from "@tanstack/react-query";
import type { ItemKey } from "@usine/core/item";
import type { RunId } from "@usine/core/run";
import type { RunAgainResult } from "@usine/engine/engine";
import type { RunView } from "@usine/orchestrator/operator";
import { unchangedRunAgain, useRunAgain } from "../run-actions.ts";

/** What a Board card shows of its Task's latest Run again request, and how it sends one. */
export interface CardRunAgain {
  /** Whether the latest request still waits for its answer. */
  readonly isPending: boolean;
  /** The answer to the latest request: the new Run, or the cycle-budget Ask that blocked it. */
  readonly data: RunAgainResult | undefined;
  /** Why the latest request failed, such as the server's refusal; null when it did not. */
  readonly error: Error | null;
  /** Runs `run` again with the task and Agent it ran with. */
  readonly send: (run: RunView) => void;
}

const cardRunAgainKey = (itemKey: ItemKey) => ["run-again", "board-card", itemKey] as const;

/**
 * Run again for the Board card of the Task whose key is `itemKey`. A card remounts when it changes
 * lanes, after a move or a poll that routes its Item elsewhere, so its requests live in the
 * mutation cache under that key rather than in the card: the remounted card still shows a pending
 * request and its answer. A `Claimed` answer opens the new Run's drawer through `openRun`, over
 * whichever screen shows when it arrives.
 */
export const useCardRunAgain = (
  itemKey: ItemKey,
  openRun: (runId: RunId) => void,
): CardRunAgain => {
  const mutationKey = cardRunAgainKey(itemKey);
  const again = useRunAgain({ mutationKey, onClaimed: openRun });
  // The cache lists the key's requests oldest first, including those an earlier mount sent.
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
