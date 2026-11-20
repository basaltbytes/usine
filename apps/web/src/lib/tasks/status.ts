import type { StalledItemView } from "@usine/orchestrator/operator";
import { Match } from "effect";
import { handedOff, waitingForCi } from "~/lib/runs/strings";
import { stallNamesLoop, stallSentence } from "~/lib/stall/strings";
import { runActivityAt, type TaskRow } from "~/lib/tasks/model";

/** Returns the tone of a stall's state mark, from the Run its reason references or from the reason. */
const stallTone = ({ reason }: StalledItemView): string =>
  Match.valueTags(reason, {
    AwaitingApproval: () => "Waiting",
    SuppressedForOperator: () => "needs-you",
    CycleBudgetUsedUp: () => "needs-you",
    RunFailed: () => "Failed",
    ClosedUnchanged: ({ run }) => run.state,
    LoopPaused: () => "paused",
    WaitingForStop: ({ run }) => run.state,
    QueuedForWorker: ({ run }) => run.state,
    WaitingForUpgrade: () => "Waiting",
    AwaitingPoll: () => "Pending",
  });

/**
 * Returns the Task's status mark state, text, and last activity time. For a stall, `at` is `null`
 * because the text has its own time, and the Loop name is prefixed if the stall text and the last
 * Run do not include it.
 */
export const statusLine = (
  { last, status }: TaskRow,
  now: number,
): {
  /** The state mark's tone; `Done` shows the current item's GitHub state instead. */
  readonly state: string;
  readonly words: string;
  readonly at: string | null;
} => {
  const at = runActivityAt(last);
  const stallLine = (stall: StalledItemView) => ({
    state: stallTone(stall),
    words: `${last.loop !== stall.loop && !stallNamesLoop(stall) ? `${stall.loop} ` : ""}${stallSentence(stall, now)}`,
    at: null,
  });
  return Match.valueTags(status, {
    AwaitingCi: () => ({ state: "AwaitingCi", words: waitingForCi, at }),
    Running: ({ run }) => ({ state: "Running", words: `Running ${run.loop}`, at }),
    AwaitingApproval: () => ({ state: "Waiting", words: "Waiting for approval", at }),
    Queued: ({ run }) => ({ state: run.state, words: run.state, at }),
    Stalled: ({ stall }) => stallLine(stall),
    Idle: ({ stall }) => stallLine(stall),
    NeedsAttention: () => ({ state: "needs-you", words: "Needs attention", at }),
    Done: () => ({ state: "Done", words: "Done", at }),
    Ended: ({ run }) => ({
      state: run.state,
      words: run.state === "HandedOff" ? handedOff : run.state,
      at,
    }),
  });
};
