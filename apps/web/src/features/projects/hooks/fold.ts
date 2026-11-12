import type { ProjectId } from "@usine/core/project";
import type { BoardLaneId, BoardLaneView } from "@usine/orchestrator/operator";
import { useState } from "react";
import { foldableLane, foldsByDefault } from "~/features/projects/lib/board";
import { laneFoldMemory } from "~/features/projects/lib/folds";

const memory = laneFoldMemory(() => window.localStorage);

type Choice = {
  readonly project: ProjectId | undefined;
  readonly lane: BoardLaneId;
  readonly folded: boolean | null;
};

const savedChoice = (project: ProjectId | undefined, lane: BoardLaneId): Choice => ({
  project,
  lane,
  folded: project === undefined ? null : memory.read(project, lane),
});

/**
 * Returns whether a lane is folded and a setter that saves the operator's choice in this browser.
 * Until the operator chooses, the lane follows `foldsByDefault`, so it opens when an open Item
 * arrives. A lane that isn't foldable never folds. Without `project`, the choice lasts until the
 * lane unmounts or changes.
 */
export const useLaneFold = (
  project: ProjectId | undefined,
  lane: BoardLaneView,
): readonly [folded: boolean, fold: (folded: boolean) => void] => {
  const [choice, setChoice] = useState(() => savedChoice(project, lane.id));
  // The same mounted column shows another project's lane after an in-app project switch.
  let current = choice;
  if (choice.project !== project || choice.lane !== lane.id) {
    current = savedChoice(project, lane.id);
    setChoice(current);
  }
  const fold = (folded: boolean) => {
    setChoice({ project, lane: lane.id, folded });
    if (project !== undefined) memory.write(project, lane.id, folded);
  };
  return [foldableLane(lane) && (current.folded ?? foldsByDefault(lane)), fold];
};
