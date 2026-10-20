import type {
  ConnectivityWarningView,
  DeskView,
  RepositoryPollView,
  RunView,
  StalledItemView,
  WorkerView,
} from "@usine/orchestrator/operator";
import { Match } from "effect";
import { clockLabel, elapsedLabel, failureReason } from "../operator-copy.ts";

/** How long ago `instant` was, as a phrase: `just now` or `12m ago`. */
export const agoLabel = (instant: string, now: number): string => {
  const elapsed = elapsedLabel(instant, now);
  return elapsed === "now" ? "just now" : `${elapsed} ago`;
};

/** When a closed Run ended: its last Attempt's end, else that Attempt's start, else its opening. */
const runClosedAt = (run: RunView): string => {
  const last = run.attempts.at(-1);
  return last?.endedAt ?? last?.startedAt ?? run.openedAt;
};

const isQuestion = (run: RunView): boolean => {
  const outcome = run.attempts.at(-1)?.outcome;
  return outcome?._tag === "Failed" && outcome.failure._tag === "QuestionFailure";
};

/** Why a matched Item is not moving, as one plain sentence. */
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

/** An open connectivity problem of an Attempt in flight, as one line. */
export const warningLine = (warning: ConnectivityWarningView): string =>
  Match.valueTags(warning, {
    WorkerSilent: ({ worker, lastAnsweredAt }) =>
      `Worker ${worker} has not answered since ${clockLabel(lastAnsweredAt)}`,
    ProviderRetrying: ({ agent, retries, since }) =>
      `${agent} cannot reach its provider, ${retries} ${retries === 1 ? "retry" : "retries"} since ${clockLabel(since)}`,
  });

/** How many Worker slots take no Attempt now, across the Workers. */
const freeSlots = (workers: ReadonlyArray<WorkerView>): number =>
  workers.reduce(
    (free, { slots: { capacity, leased } }) => free + Math.max(0, capacity - leased),
    0,
  );

/** What the empty Running now block says: nothing runs, and how many slots are free. */
export const nothingRunning = (workers: ReadonlyArray<WorkerView>): string => {
  const total = workers.reduce((sum, { slots }) => sum + slots.capacity, 0);
  const free = freeSlots(workers);
  if (total === 0) return "Nothing is running.";
  return `Nothing is running. ${free} of ${total} Worker ${total === 1 ? "slot is" : "slots are"} free.`;
};

/** When the factory last checked each repository, such as `Last checked 2m ago`, or none without repositories. */
export const lastCheckedLabel = (
  polls: ReadonlyArray<RepositoryPollView>,
  now: number,
): string | null => {
  if (polls.length === 0) return null;
  if (polls.every(({ polledAt }) => polledAt === null)) return "No poll has finished yet";
  const [only] = polls;
  if (polls.length === 1 && only !== undefined && only.polledAt !== null) {
    return `Last checked ${agoLabel(only.polledAt, now)}`;
  }
  return `Last checked ${polls
    .map(
      ({ repository, polledAt }) =>
        `${repository} ${polledAt === null ? "not yet" : agoLabel(polledAt, now)}`,
    )
    .join(", ")}`;
};

/** The desk heading's counts, such as `2 running, 7 not moving`; none when both are zero. */
export const deskCounts = (desk: DeskView): string | undefined => {
  const parts = [
    desk.running.length > 0 ? `${desk.running.length} running` : null,
    desk.notMoving.length > 0 ? `${desk.notMoving.length} not moving` : null,
  ].filter((part) => part !== null);
  return parts.length === 0 ? undefined : parts.join(", ");
};

/** The number of a GitHub pull request URL, such as `#402`; the URL itself when it names none. */
export const pullRequestLabel = (url: string): string => {
  const number = /\/pull\/(\d+)/u.exec(url)?.[1];
  return number === undefined ? url : `#${number}`;
};
