import type { RunView, StalledItemView } from "@usine/orchestrator/operator";
import { Match } from "effect";
import { agoLabel, failureReason } from "../operator-copy.ts";

/** When a closed Run ended: its last Attempt's end, else that Attempt's start, else its opening. */
const runClosedAt = (run: RunView): string => {
  const last = run.attempts.at(-1);
  return last?.endedAt ?? last?.startedAt ?? run.openedAt;
};

const isQuestion = (run: RunView): boolean => {
  const outcome = run.attempts.at(-1)?.outcome;
  return outcome?._tag === "Failed" && outcome.failure._tag === "QuestionFailure";
};

/** Why a matched Item is not moving, as one plain sentence. The desk and the Board both say it. */
export const stallSentence = ({ loop, reason }: StalledItemView, now: number): string =>
  Match.valueTags(reason, {
    AwaitingApproval: () => "Its Run waits for your approval.",
    HeldForOperator: ({ run }) =>
      isQuestion(run)
        ? "The Agent asked you a question. The Loop waits for your answer."
        : "The Agent reported a blocker. The Loop waits until you resolve it or the Item changes.",
    CycleBudgetUsedUp: ({ ask }) =>
      `The Item used its cycle budget of ${ask.limit} rounds. No Run opens until you reset it.`,
    RunFailed: ({ run }) => {
      const outcome = run.attempts.at(-1)?.outcome;
      const why = outcome?._tag === "Failed" ? `: ${failureReason(outcome.failure)}` : "";
      return `Its Run failed ${agoLabel(runClosedAt(run), now)}${why}. The Loop waits for a retry.`;
    },
    ClosedUnchanged: ({ run }) =>
      `Its Run ${run.state === "Succeeded" ? "succeeded" : "was canceled"} ${agoLabel(runClosedAt(run), now)} and the Item has not changed since, so no Run opens.`,
    LoopPaused: () => `${loop} is paused, so it opens no Run.`,
    QueuedForWorker: () => "Its Run waits for a free Worker slot.",
    AwaitingPoll: () =>
      "The Loop has not acted on the Item's current state yet. The next poll does.",
  });
