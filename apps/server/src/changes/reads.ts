import { isSettledItemState } from "@usine/config/board";
import {
  BoardView,
  ProjectView,
  TaskIdentityView,
  ReadyOverview,
  NeedsSetupOverview,
  ReadOnlyBoardLaneView,
  WritableBoardLaneView,
  type FactoryOverview,
  type BoardLaneView,
} from "@usine/orchestrator/operator";

const historyLane = (lane: BoardLaneView): boolean =>
  lane.sources.length > 0 &&
  lane.sources.every((source) => "state" in source && isSettledItemState(source.state));

/** Omits board cards from navigation reads; open run summaries retain the running badge. */
export const shellOverview = (overview: FactoryOverview): FactoryOverview => {
  const values = {
    loops: overview.loops,
    needsYou: [],
    dismissedNeeds: [],
    identities: overview.projects.flatMap(({ board }) =>
      board.lanes.flatMap(({ items }) => items.map((item) => new TaskIdentityView(item))),
    ),
    projects: overview.projects.map(
      (project) =>
        new ProjectView({
          ...project,
          board: new BoardView({ failures: [], lanes: [] }),
          labels: [],
        }),
    ),
  };
  return overview._tag === "Ready"
    ? new ReadyOverview(values)
    : new NeedsSetupOverview({ ...values, errorTag: overview.errorTag });
};

export const pagedBoard = (project: ProjectView): ProjectView =>
  new ProjectView({
    ...project,
    board: new BoardView({
      ...project.board,
      lanes: project.board.lanes.map((lane) =>
        historyLane(lane)
          ? lane._tag === "ReadOnlyBoardLane"
            ? new ReadOnlyBoardLaneView({ ...lane, totalItems: lane.items.length, items: [] })
            : new WritableBoardLaneView({ ...lane, totalItems: lane.items.length, items: [] })
          : lane,
      ),
    }),
  });

export const attentionOverview = (overview: FactoryOverview): FactoryOverview => {
  const values = {
    projects: [],
    identities: [],
    loops: [],
    needsYou: overview.needsYou,
    dismissedNeeds: overview.dismissedNeeds,
  };
  return overview._tag === "Ready"
    ? new ReadyOverview(values)
    : new NeedsSetupOverview({ ...values, errorTag: overview.errorTag });
};
