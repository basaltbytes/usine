import { isSettledItemState } from "@usine/config/board";
import {
  BoardView,
  PAGE_BYTES,
  pageOf,
  ProjectView,
  TaskIdentityView,
  TaskView,
  ReadyOverview,
  NeedsSetupOverview,
  ReadOnlyBoardLaneView,
  WritableBoardLaneView,
  type FactoryOverview,
  type BoardLaneView,
} from "@usine/orchestrator/operator";
import { Struct } from "effect";

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
      board.lanes.flatMap(({ items }) => items.map((item) => TaskIdentityView.make(item))),
    ),
    projects: overview.projects.map((project) =>
      ProjectView.make({
        ...project,
        board: BoardView.make({ failures: [], lanes: [] }),
        labels: [],
      }),
    ),
  };
  return overview._tag === "Ready"
    ? ReadyOverview.make(values)
    : NeedsSetupOverview.make({ ...values, errorTag: overview.errorTag });
};

const countedLane = (lane: BoardLaneView): BoardLaneView =>
  lane._tag === "ReadOnlyBoardLane"
    ? ReadOnlyBoardLaneView.make({ ...lane, totalItems: lane.items.length, items: [] })
    : WritableBoardLaneView.make({ ...lane, totalItems: lane.items.length, items: [] });

export const pagedBoard = (project: ProjectView): ProjectView =>
  ProjectView.make({
    ...project,
    board: BoardView.make({
      ...project.board,
      cardedItemKeys: project.board.lanes.flatMap(({ items }) =>
        items.flatMap(({ items }) => items.map(({ itemKey }) => itemKey)),
      ),
      lanes: project.board.lanes.map((lane) => (historyLane(lane) ? countedLane(lane) : lane)),
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
    ? ReadyOverview.make(values)
    : NeedsSetupOverview.make({ ...values, errorTag: overview.errorTag });
};

/** Returns `project` with each lane's card count instead of its cards, and without runs or labels. */
export const projectSummary = (project: ProjectView): ProjectView =>
  ProjectView.make({
    ...Struct.omit(project, ["runs", "labels"]),
    board: BoardView.make({
      failures: project.board.failures,
      lanes: project.board.lanes.map(countedLane),
    }),
  });

/** Returns `overview` with each project as its summary. */
export const summaryOverview = (overview: FactoryOverview): FactoryOverview => {
  const values = {
    identities: [],
    projects: overview.projects.map(projectSummary),
    loops: overview.loops,
    needsYou: overview.needsYou,
    dismissedNeeds: overview.dismissedNeeds,
  };
  return overview._tag === "Ready"
    ? ReadyOverview.make(values)
    : NeedsSetupOverview.make({ ...values, errorTag: overview.errorTag });
};

/** The most bytes of JSON that the runs of a task summary hold. */
const TASK_SUMMARY_RUNS_BYTES = PAGE_BYTES / 2;
/** The number of runs that the first read of the web UI's task page holds. */
const TASK_PAGE_RUNS = 25;

/** Returns `task` without run results, with its newest runs that fit `TASK_SUMMARY_RUNS_BYTES`. */
export const taskSummary = (task: TaskView): TaskView =>
  TaskView.make({
    ...Struct.omit(task, ["comments", "attemptChanges", "commentRuns"]),
    runs: pageOf(task.runs, 0, TASK_PAGE_RUNS, TASK_SUMMARY_RUNS_BYTES).entries,
    runsTotal: task.runs.length,
  });

/** Returns `task` with its first 25 runs and the identities of every run. */
export const taskPage = (task: TaskView): TaskView =>
  TaskView.make({
    ...task,
    runsTotal: task.runs.length,
    runs: task.runs.slice(0, TASK_PAGE_RUNS),
    commentRuns: task.runs.map(({ id, repository, itemKey, loop }) => ({
      id,
      repository,
      itemKey,
      loop,
    })),
  });
