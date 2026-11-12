import type { ProjectId } from "@usine/core/project";
import type { BoardLaneView } from "@usine/orchestrator/operator";
import { useState } from "react";
import { foldableLane, foldsByDefault } from "~/features/projects/lib/board";
import { laneFoldMemory } from "~/features/projects/lib/folds";

const memory = laneFoldMemory(() => window.localStorage);

/**
 * Returns whether a lane is folded and a setter that saves the operator's choice in this browser.
 * Until the operator chooses, the lane follows `foldsByDefault`, so it opens when an open Item
 * arrives. Without `project`, the choice lasts until the lane unmounts.
 */
export const useLaneFold = (
  project: ProjectId | undefined,
  lane: BoardLaneView,
): readonly [folded: boolean, fold: (folded: boolean) => void] => {
  const [chosen, setChosen] = useState(() =>
    project === undefined ? null : memory.read(project, lane.id),
  );
  const fold = (folded: boolean) => {
    setChosen(folded);
    if (project !== undefined) memory.write(project, lane.id, folded);
  };
  return [foldableLane(lane) && (chosen ?? foldsByDefault(lane)), fold];
};
