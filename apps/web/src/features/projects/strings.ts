import type { RunView } from "@usine/orchestrator/operator";
import { openedTitle } from "~/lib/runs/strings";
import { timestampLabel } from "~/lib/strings";

/** Returns the tooltip for the time on a Board card's Run line, with the start time and what it marks. */
export const runLineTimeTitle = (state: RunView["state"], since: string): string => {
  if (state === "Running") return `Running since ${timestampLabel(since)}`;
  if (state === "Failed") return `Failed at ${timestampLabel(since)}`;
  return openedTitle(since);
};
