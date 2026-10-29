import type { BoardMoveProgress } from "~/hooks/projects/moves";

export const moveProgressMessage = (phase: BoardMoveProgress["phase"]): string =>
  phase === "saving" ? "Moving…" : "Saved on GitHub · syncing…";

export const moveToLaneLabel = (lane: string) => `Move to ${lane}`;

export const laneFoldCommand = (lane: string, folded: boolean) =>
  `${folded ? "Open" : "Fold"} ${lane} lane`;
