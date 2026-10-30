import type { RunView, StalledItemView } from "@usine/orchestrator/operator";
import { Match } from "effect";
import { agoLabel } from "~/lib/strings";
import { machineCreationLine } from "~/lib/workers/strings";
import { failureReason, stopWaitLine } from "~/lib/runs/strings";
import { runActivityAt } from "~/lib/tasks/model";

const isQuestion = (run: RunView): boolean => {
  const outcome = run.attempts.at(-1)?.outcome;
  return outcome?._tag === "Failed" && outcome.failure._tag === "QuestionFailure";
};

/** Returns whether the stall fragment already starts with the Loop name, as `review paused` does, so callers do not prefix it. */
export const stallNamesLoop = ({ reason }: StalledItemView): boolean =>
  reason._tag === "LoopPaused";

/** Returns a short fragment that states why a matched Item is stalled. */
export const stallSentence = ({ loop, reason }: StalledItemView, now: number): string =>
  Match.valueTags(reason, {
    AwaitingApproval: () => "Waiting for approval",
    SuppressedForOperator: ({ run }) =>
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
    WaitingForStop: ({ run, stop }) => stopWaitLine(run.id, stop),
    QueuedForWorker: ({ ahead, creating, priority }) =>
      creating !== null
        ? machineCreationLine(creating, now)
        : [
            "Waiting for a free worker slot",
            ...(priority === null ? [] : [`priority ${priority}`]),
            ...(ahead === null
              ? []
              : [
                  ahead === 0 ? "next in queue" : `behind ${ahead} ${ahead === 1 ? "run" : "runs"}`,
                ]),
          ].join(", "),
    AwaitingPoll: () => "Waiting for the next poll",
  });
