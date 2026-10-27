import { OPEN_STATE_TAGS } from "@usine/core/run/state";
import type {
  BoardLaneView,
  BoardTaskView,
  LabelView,
  RunView,
} from "@usine/orchestrator/operator";
import { failedRun, failureNeedsYou } from "~/lib/projects/failure";

export type LabelCatalog = ReadonlyMap<string, LabelView>;

const OPEN_STATES = new Set<RunView["state"]>(OPEN_STATE_TAGS);

/** Returns the card's Run: an open Run or a failed Run that needs the operator, else `null`. */
export const currentRun = (item: BoardTaskView): RunView | null => {
  const run = item.run;
  return run !== null && (OPEN_STATES.has(run.state) || failureNeedsYou(item, run)) ? run : null;
};

/** Returns when the Run opened while it waits, when the current Attempt started while it runs, or
 * when the last Attempt ended once it failed. Returns `null` if that time is not recorded. */
export const runLineSince = (run: RunView): string | null => {
  const last = run.attempts.at(-1);
  switch (run.state) {
    case "Pending":
    case "Waiting":
    case "Queued":
      return run.openedAt;
    case "Running":
      return last !== undefined && last.outcome === null ? last.startedAt : null;
    case "Failed":
      return last?.endedAt ?? null;
    case "Succeeded":
    case "Canceled":
      return null;
  }
};

/** Returns the failure message of the newest Run that needs attention, or `null`. */
export const itemFailure = (item: BoardTaskView): string | null => failedRun(item)?.message ?? null;

/** Returns the card's labels without the lane's own labels. */
export const cardLabels = (item: BoardTaskView, lane: BoardLaneView): ReadonlyArray<string> => {
  const own = new Set<string>(lane._tag === "WritableBoardLane" ? lane.labels : []);
  for (const source of lane.sources) if ("label" in source) own.add(source.label);
  return item.labels.filter((label) => !own.has(label));
};
