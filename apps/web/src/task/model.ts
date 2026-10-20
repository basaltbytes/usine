import type { LaneItemState, LaneName } from "@usine/config/board";
import type { LoopName } from "@usine/core/loop";
import type { CommentKind } from "@usine/core/step/result";
import type {
  BoardLaneView,
  BoardTaskView,
  FailureView,
  RunView,
  StalledItemView,
  TaskItemView,
} from "@usine/orchestrator/operator";
import { Option } from "effect";

/**
 * How long a Run's Attempts ran, added up: each ended Attempt from its start to its end, and a
 * live Attempt up to `now`. None when no Attempt started, or when an ended Attempt has no
 * recorded end, since the sum would then undercount.
 */
export const attemptsDuration = (
  run: Pick<RunView, "attempts">,
  now: number,
): Option.Option<number> => {
  if (run.attempts.length === 0) return Option.none();
  let total = 0;
  for (const attempt of run.attempts) {
    const end =
      attempt.outcome === null
        ? now
        : attempt.endedAt === null
          ? Number.NaN
          : Date.parse(attempt.endedAt);
    if (Number.isNaN(end)) return Option.none();
    total += Math.max(0, end - Date.parse(attempt.startedAt));
  }
  return Option.some(total);
};

/** The typed failure that closed a Failed Run's latest Attempt; none for any other Run. */
export const runFailure = (
  run: Pick<RunView, "state" | "attempts">,
): Option.Option<FailureView> => {
  const outcome = run.attempts.at(-1)?.outcome;
  return run.state === "Failed" && outcome?._tag === "Failed"
    ? Option.some(outcome.failure)
    : Option.none();
};

/** An Item's state and kind in words, such as `Open issue` or `Merged pull request #41`; the
 * number is named when the Item is not the Task's originating one. */
export const itemStateLine = (
  item: Pick<TaskItemView, "kind" | "number" | "state">,
  origin: boolean,
): string => {
  const kind = item.kind === "pr" ? "pull request" : "issue";
  return `${itemStateLabel(item.state)} ${kind}${origin ? "" : ` #${item.number}`}`;
};

const CLOSED_STATES = new Set<LaneItemState>(["issue-closed", "pr-closed", "pr-merged"]);

/** Whether an Item is closed: a closed issue, or a closed or merged pull request. A Task whose
 * current Item is closed is done, and a lane that holds only closed Items is a Done lane. */
export const isClosedItem = (state: LaneItemState): boolean => CLOSED_STATES.has(state);

/** When a Run was last at work: its last Attempt's end, that Attempt's start while it runs or
 * when no end was recorded, or when the Run opened before any Attempt started. */
export const runActivityAt = (run: Pick<RunView, "attempts" | "openedAt">): string => {
  const last = run.attempts.at(-1);
  return last?.endedAt ?? last?.startedAt ?? run.openedAt;
};

/** The stall of a Task: the first entry of the desk's stalled list that is about one of the
 * Task's Items, or null when none is. */
export const taskStall = (
  stalled: ReadonlyArray<StalledItemView>,
  task: Pick<BoardTaskView, "items">,
): StalledItemView | null => {
  const keys = new Set(task.items.map(({ itemKey }) => itemKey));
  return stalled.find(({ item }) => keys.has(item.itemKey)) ?? null;
};

/** The number that addresses a Task's page: its originating Item's, the first of its Items. */
export const taskNumber = (task: Pick<BoardTaskView, "items" | "number">): string =>
  String(task.items[0]?.number ?? task.number);

/** A Task as a row of the Tasks list: the Task, the lane it sits in, and when it was last active. */
export interface TaskRow {
  readonly task: BoardTaskView;
  readonly lane: LaneName;
  /** When its last Run was last at work or, for a Task without Runs, when GitHub last updated
   * its current Item. */
  readonly activeAt: string;
}

/** Every Task of the lanes as a Tasks list row, the most recently active first; of two Tasks
 * active at the same time, the one with the higher current Item number comes first. */
export const taskRows = (lanes: ReadonlyArray<BoardLaneView>): ReadonlyArray<TaskRow> =>
  lanes
    .flatMap(({ name, items }) =>
      items.map((task) => {
        const last = task.runs.at(-1);
        return {
          task,
          lane: name,
          activeAt: last === undefined ? task.updatedAt : runActivityAt(last),
        };
      }),
    )
    .sort(
      (a, b) => Date.parse(b.activeAt) - Date.parse(a.activeAt) || b.task.number - a.task.number,
    );

/** The Loops that ran on a Task, each named once, in the order they first ran. */
export const taskLoops = (task: Pick<BoardTaskView, "runs">): ReadonlyArray<LoopName> => [
  ...new Set(task.runs.map(({ loop }) => loop)),
];

/** An Item's state as GitHub names it: Open, Closed, or Merged. */
export const itemStateLabel = (state: LaneItemState): string => {
  switch (state) {
    case "issue-open":
    case "pr-open":
      return "Open";
    case "issue-closed":
    case "pr-closed":
      return "Closed";
    case "pr-merged":
      return "Merged";
  }
};

/** What an Agent posted, as GitHub names it. */
export const commentKindLabel = (kind: CommentKind): string => {
  switch (kind) {
    case "issue-comment":
      return "Comment";
    case "review":
      return "Review";
    case "review-comment":
      return "Review comment";
  }
};

/** An Item's number and kind, as Board cards show them: `#41 PR` or `#40 Issue`. */
export const itemReference = (item: Pick<TaskItemView, "kind" | "number">): string =>
  `#${item.number} ${item.kind === "pr" ? "PR" : "Issue"}`;
