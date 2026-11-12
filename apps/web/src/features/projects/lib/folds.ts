import { ProjectId } from "@usine/core/project";
import { BoardLaneId } from "@usine/orchestrator/operator";
import { Schema } from "effect";
import { browserArchive } from "~/lib/browser-archive";

const maximumLanes = 200;
const LaneFold = Schema.Struct({ project: ProjectId, lane: BoardLaneId, folded: Schema.Boolean });
type LaneFold = typeof LaneFold.Type;
const LaneFolds = Schema.fromJsonString(
  Schema.Struct({
    version: Schema.Literal(1),
    lanes: Schema.Array(LaneFold).check(Schema.isMaxLength(maximumLanes)),
  }),
);

/**
 * Stores the operator's fold choice for the 200 most recently folded or opened lanes, in at most
 * 64,000 characters. See `browserArchive` for corrupt data and denied storage.
 */
export const laneFoldMemory = (storage: () => Pick<Storage, "getItem" | "setItem">) => {
  const archive = browserArchive<typeof LaneFolds.Type, LaneFold>(
    {
      key: "usine:board-lane-folds:v1",
      schema: LaneFolds,
      entries: ({ lanes }) => lanes,
      document: (lanes) => ({ version: 1, lanes }),
      maximumEntries: maximumLanes,
      maximumSize: 64_000,
      span: "LaneFold",
      label: "Board lane fold storage",
    },
    storage,
  );
  return {
    /** Returns the saved choice, or null if the operator never folded or opened the lane. */
    read: (project: ProjectId, lane: BoardLaneId): boolean | null =>
      archive.read(
        { project, lane },
        (lanes) =>
          lanes.find((entry) => entry.project === project && entry.lane === lane)?.folded ?? null,
        null,
      ),
    write: (project: ProjectId, lane: BoardLaneId, folded: boolean): void =>
      archive.update({ project, lane }, (lanes) => [
        { project, lane, folded },
        ...lanes.filter((entry) => entry.project !== project || entry.lane !== lane),
      ]),
  };
};
