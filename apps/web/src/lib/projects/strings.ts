import type { BoardMoveProgress } from "~/hooks/projects/moves";

export const moveProgressMessage = (phase: BoardMoveProgress["phase"]): string =>
  phase === "saving" ? "Moving…" : "Saved on GitHub · syncing…";
