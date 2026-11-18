import { isSettledItemState } from "@usine/config/board";
import { ChangedFile, FileChanges } from "@usine/github/file-changes";
import {
  BoardView,
  DeskView,
  jsonBytes,
  PAGE_BYTES,
  pageOf,
  ProjectView,
  TaskIdentityView,
  TaskView,
  ReadyOverview,
  NeedsSetupOverview,
  ReadOnlyBoardLaneView,
  WritableBoardLaneView,
  textPrefix,
  type FactoryOverview,
  type BoardLaneView,
} from "@usine/orchestrator/operator";
import { ConfigurationRevisionPage } from "@usine/orchestrator/operator/http";
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

/** Returns the entries of `list` from its start whose JSON fits `bytes`, and the bytes they use. */
const fitting = <A>(list: ReadonlyArray<A>, bytes: number) => {
  const entries: Array<A> = [];
  let used = 0;
  for (const entry of list) {
    const size = jsonBytes(entry) + 1;
    if (used + size > bytes) break;
    entries.push(entry);
    used += size;
  }
  return { entries, used };
};

/**
 * Returns `desk` with its running attempts, then its items not moving, then its last outcomes, as
 * many as fit one page, and the number of entries of each list that it leaves out.
 */
export const boundedDesk = (desk: DeskView): DeskView => {
  const omitted = { running: 0, notMoving: 0, lastOutcomes: 0 };
  let remaining =
    PAGE_BYTES -
    jsonBytes(
      DeskView.make({
        ...desk,
        running: [],
        notMoving: [],
        lastOutcomes: [],
        omitted: {
          running: desk.running.length,
          notMoving: desk.notMoving.length,
          lastOutcomes: desk.lastOutcomes.length,
        },
      }),
    );
  const take = <A>(list: ReadonlyArray<A>, key: keyof typeof omitted) => {
    const { entries, used } = fitting(list, remaining);
    remaining -= used;
    omitted[key] = list.length - entries.length;
    return entries;
  };
  return DeskView.make({
    ...desk,
    running: take(desk.running, "running"),
    notMoving: take(desk.notMoving, "notMoving"),
    lastOutcomes: take(desk.lastOutcomes, "lastOutcomes"),
    omitted,
  });
};

/** The most files of a page of pull request files. */
const FILES_PAGE = 100;

/**
 * Returns the files of `changes` from `offset` that fit one page, with the total and the offset of
 * the next page. A first file whose patch alone doesn't fit has its patch cut and marked truncated.
 */
export const fileChangesPage = (changes: FileChanges, offset: number): FileChanges => {
  const total = changes.files.length;
  const envelope = jsonBytes(FileChanges.make({ ...changes, files: [], total, nextOffset: total }));
  // `pageOf` counts the brackets of the list, which `envelope` already counts.
  const page = pageOf(changes.files, offset, FILES_PAGE, PAGE_BYTES - envelope + 2);
  const [first] = page.entries;
  const files =
    page.entries.length === 1 &&
    first !== undefined &&
    first.patch.kind === "text" &&
    envelope + jsonBytes(first) > PAGE_BYTES
      ? [cutPatch(first, first.patch.text, PAGE_BYTES - envelope)]
      : page.entries;
  return FileChanges.make({ ...changes, files, total, nextOffset: page.nextOffset });
};

/** Returns `file` with the start of its patch `text` that keeps the file's JSON within `bytes`. */
const cutPatch = (file: ChangedFile, text: string, bytes: number) => {
  const empty = ChangedFile.make({ ...file, patch: { kind: "text", text: "", truncated: true } });
  return ChangedFile.make({
    ...empty,
    patch: { kind: "text", text: textPrefix(text, bytes - jsonBytes(empty)), truncated: true },
  });
};

/** Returns `page` with as many of its revisions as fit one page, and the cursor after the last. */
export const revisionPage = (page: ConfigurationRevisionPage): ConfigurationRevisionPage => {
  const [newest] = page.revisions;
  if (newest === undefined) return page;
  // The newest revision has the largest number, so it is the widest cursor.
  const envelope = Math.max(
    jsonBytes(ConfigurationRevisionPage.make({ revisions: [], nextBefore: null })),
    jsonBytes(ConfigurationRevisionPage.make({ revisions: [], nextBefore: newest.number })),
  );
  const { entries } = pageOf(page.revisions, 0, page.revisions.length, PAGE_BYTES - envelope + 2);
  const last = entries.at(-1);
  return entries.length === page.revisions.length || last === undefined
    ? page
    : ConfigurationRevisionPage.make({ revisions: entries, nextBefore: last.number });
};
