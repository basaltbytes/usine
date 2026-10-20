import type { RunView, StalledItemView } from "@usine/orchestrator/operator";
import { Match } from "effect";
import { agoLabel, failureReason } from "../operator-copy.ts";
import { runActivityAt } from "../task/model.ts";

const isQuestion = (run: RunView): boolean => {
  const outcome = run.attempts.at(-1)?.outcome;
  return outcome?._tag === "Failed" && outcome.failure._tag === "QuestionFailure";
};

/** Whether the stall fragment starts with its Loop, as `review paused` does, so no Loop name
 * goes before it. */
export const stallNamesLoop = ({ reason }: StalledItemView): boolean =>
  reason._tag === "LoopPaused";

/** Why a matched Item is stalled, as one short fragment. The overview page and the Board both show it. */
export const stallSentence = ({ loop, reason }: StalledItemView, now: number): string =>
  Match.valueTags(reason, {
    AwaitingApproval: () => "Waiting for approval",
    HeldForOperator: ({ run }) =>
      isQuestion(run) ? "Question from the agent" : "Blocked by the agent",
    CycleBudgetUsedUp: ({ ask }) => `Cycle budget used, ${ask.limit} rounds`,
    RunFailed: ({ run }) => {
      const outcome = run.attempts.at(-1)?.outcome;
      const why = outcome?._tag === "Failed" ? `: ${failureReason(outcome.failure)}` : "";
      return `Failed ${agoLabel(runActivityAt(run), now)}${why}`;
    },
    ClosedUnchanged: ({ run }) =>
      `${run.state === "Succeeded" ? "Succeeded" : "Canceled"} ${agoLabel(runActivityAt(run), now)}, unchanged since`,
    LoopPaused: () => `${loop} paused`,
    QueuedForWorker: () => "Waiting for a free worker slot",
    AwaitingPoll: () => "Waiting for the next poll",
  });
