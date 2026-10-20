import { isSettledItemState, type LaneItemState } from "@usine/config/board";
import type { LoopName } from "@usine/core/loop";
import type { CommentKind } from "@usine/core/step/result";
import type {
  BoardItemLink,
  BoardLaneView,
  BoardTaskView,
  FailureView,
  RunView,
  StalledItemView,
  TaskItemView,
  TaskUsageView,
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

/** When a Run was last at work: when it closed, even before any Attempt began; while it is open,
 * its last Attempt's end, that Attempt's start while it runs or when no end was recorded, or when
 * the Run opened before any Attempt started. */
export const runActivityAt = (run: Pick<RunView, "attempts" | "openedAt" | "closedAt">): string => {
  const last = run.attempts.at(-1);
  return run.closedAt ?? last?.endedAt ?? last?.startedAt ?? run.openedAt;
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

/** The Run a stall reason names, or null when the reason is about the Loop or the Item alone, as
 * a paused Loop, a used-up cycle budget, or a coming poll are. */
export const stallRun = ({ reason }: Pick<StalledItemView, "reason">): RunView | null =>
  "run" in reason ? reason.run : null;

/** A Task's originating Item, the first of its Items: its earliest issue, or its earliest pull
 * request when it has none. */
export const taskOrigin = (task: BoardTaskView): BoardItemLink =>
  // The view's schema refuses a Task without Items; the current Item only satisfies the type.
  task.items[0] ?? task;

/** The number that addresses a Task's page: its originating Item's. */
export const taskNumber = (task: BoardTaskView): string => String(taskOrigin(task).number);

/**
 * Where usine's work on a Task stands, as the Tasks list's Status column says it. Running,
 * AwaitingApproval, Queued, and Stalled are in flight, each with the Run whose opening orders it
 * in the list.
 */
type TaskStatus =
  /** `run` has an Attempt at work. */
  | { readonly _tag: "Running"; readonly run: RunView }
  /** `run` waits for the operator's approval. */
  | { readonly _tag: "AwaitingApproval"; readonly run: RunView }
  /** `run` is pending or queued, and the desk has not said why yet. */
  | { readonly _tag: "Queued"; readonly run: RunView }
  /**
   * A Loop's trigger matches one of the Task's Items with no Attempt running on it, for `stall`'s
   * reason; `run` is the Run that reason names, the pending or queued one when one is open, else
   * the last Run.
   */
  | { readonly _tag: "Stalled"; readonly stall: StalledItemView; readonly run: RunView }
  /** Nothing is open or stalled, and a failed Run or a hold on one of the Items waits on the
   * operator, as the Board card's Needs attention says. */
  | { readonly _tag: "NeedsAttention" }
  /** The current Item is merged or closed and no Run is open. */
  | { readonly _tag: "Done" }
  /** Nothing is open, stalled, or waiting on the operator: the last Run's outcome stands. */
  | { readonly _tag: "Ended"; readonly run: RunView };

/** A Task usine ran at least once, as a row of the Tasks list. */
export interface TaskRow {
  readonly task: BoardTaskView;
  /** The Task's latest Run, which the Last run column shows. */
  readonly last: RunView;
  readonly status: TaskStatus;
}

const isInFlight = (status: TaskStatus): boolean =>
  status._tag === "Running" ||
  status._tag === "AwaitingApproval" ||
  status._tag === "Queued" ||
  status._tag === "Stalled";

/** The first Run, newest first, whose state is one of `states`. */
const newestIn = (
  runs: ReadonlyArray<RunView>,
  ...states: ReadonlyArray<RunView["state"]>
): RunView | undefined => [...runs].reverse().find(({ state }) => states.includes(state));

/**
 * A Task's status, the first that applies: a Run at work, a Run waiting for approval, a pending or
 * queued Run with the desk's reason for that Run, Done for a merged or closed current Item, the
 * desk's stall, Needs attention, and last the outcome of `last`. `stalled` is the desk's list.
 */
const taskStatus = (
  task: BoardTaskView,
  last: RunView,
  stalled: ReadonlyArray<StalledItemView>,
): TaskStatus => {
  const running = newestIn(task.runs, "Running");
  if (running !== undefined) return { _tag: "Running", run: running };
  const waiting = newestIn(task.runs, "Waiting");
  if (waiting !== undefined) return { _tag: "AwaitingApproval", run: waiting };
  const queued = newestIn(task.runs, "Pending", "Queued");
  if (queued !== undefined) {
    // The desk lists a stall per Loop and Item, and one about an older closed Run on another of
    // the Task's Items can come first; only the reason that names the queued Run explains it.
    const own = stalled.find((stall) => stallRun(stall)?.id === queued.id);
    return own === undefined
      ? { _tag: "Queued", run: queued }
      : { _tag: "Stalled", stall: own, run: queued };
  }
  if (isSettledItemState(task.state)) return { _tag: "Done" };
  const stall = taskStall(stalled, task);
  if (stall !== null) return { _tag: "Stalled", stall, run: stallRun(stall) ?? last };
  if (task.needsYou) return { _tag: "NeedsAttention" };
  return { _tag: "Ended", run: last };
};

/**
 * A row's place in the list: its group, then the time that orders it within the group, newest
 * first. In flight comes first, running, then waiting for approval, then pending, queued, and
 * stalled, each by when its Run opened; every other Task follows, by when its last Run closed,
 * which for a Run canceled before any Attempt is the cancel, not its opening.
 */
const rowPlace = ({ status, last }: TaskRow): readonly [group: number, at: number] => {
  switch (status._tag) {
    case "Running":
      return [0, Date.parse(status.run.openedAt)];
    case "AwaitingApproval":
      return [1, Date.parse(status.run.openedAt)];
    case "Queued":
    case "Stalled":
      return [2, Date.parse(status.run.openedAt)];
    case "NeedsAttention":
    case "Done":
    case "Ended":
      return [3, Date.parse(runActivityAt(last))];
  }
};

/**
 * The Tasks of the lanes that have at least one Run, as Tasks list rows in the list's order (see
 * `rowPlace`); of two Tasks placed alike, the one with the higher current Item number comes
 * first. `stalled` is the desk's list of stalled Items, which a row's status reads.
 */
export const taskRows = (
  lanes: ReadonlyArray<BoardLaneView>,
  stalled: ReadonlyArray<StalledItemView>,
): ReadonlyArray<TaskRow> =>
  lanes
    .flatMap(({ items }) => items)
    .flatMap((task) => {
      const last = task.runs.at(-1);
      return last === undefined ? [] : [{ task, last, status: taskStatus(task, last, stalled) }];
    })
    .map((row) => ({ row, place: rowPlace(row) }))
    .sort(
      ({ row: a, place: [groupA, atA] }, { row: b, place: [groupB, atB] }) =>
        groupA - groupB || atB - atA || b.task.number - a.task.number,
    )
    .map(({ row }) => row);

/**
 * The Tasks list's heading counts, such as `2 in flight, 1 needs attention, 2 done`, leaving out a
 * zero count; undefined when all three are zero.
 */
export const taskCounts = (rows: ReadonlyArray<TaskRow>): string | undefined => {
  const counts = [
    [rows.filter(({ status }) => isInFlight(status)).length, "in flight"],
    [rows.filter(({ status }) => status._tag === "NeedsAttention").length, "needs attention"],
    [rows.filter(({ status }) => status._tag === "Done").length, "done"],
  ] as const;
  const shown = counts.filter(([count]) => count > 0);
  return shown.length === 0
    ? undefined
    : shown.map(([count, what]) => `${count} ${what}`).join(", ");
};

/**
 * A Task's Attempt time at `now`: its ended Attempts' time, and each Attempt at work counted from
 * its start up to `now`.
 */
export const taskDuration = (
  usage: Pick<TaskUsageView, "durationMillis" | "runningSince">,
  now: number,
): number =>
  usage.runningSince.reduce(
    (total, since) => total + Math.max(0, now - Date.parse(since)),
    usage.durationMillis,
  );

/**
 * Whether part of a Task's usage in a pool with a dollar rate has no price yet, so its cost is a
 * lower bound.
 */
export const costUnpriced = (usage: Pick<TaskUsageView, "pools">): boolean =>
  usage.pools.some(({ unpriced }) => unpriced);

/** What the listed Tasks took, added up, as the line under the Tasks list's heading says. */
export interface TaskTotals {
  readonly runs: number;
  readonly durationMillis: number;
  /** Ended Attempts with no recorded end, which `durationMillis` leaves out. */
  readonly unmeasured: number;
  readonly tokens: number;
  /** The priced Tasks' dollars, an estimate when any is; null when no Task has a price. */
  readonly cost: { readonly usd: number; readonly estimate: boolean } | null;
  /** Whether a listed Task has usage with no price yet, so `cost` is a lower bound. */
  readonly unpriced: boolean;
}

/** The runs, Attempt time at `now`, tokens, and dollars of every row, added up. */
export const taskTotals = (rows: ReadonlyArray<TaskRow>, now: number): TaskTotals => {
  const costs = rows.flatMap(({ task }) => (task.usage.cost === null ? [] : [task.usage.cost]));
  return {
    runs: rows.reduce((sum, { task }) => sum + task.runs.length, 0),
    durationMillis: rows.reduce((sum, { task }) => sum + taskDuration(task.usage, now), 0),
    unmeasured: rows.reduce((sum, { task }) => sum + task.usage.unmeasured, 0),
    tokens: rows.reduce((sum, { task }) => sum + task.usage.tokens, 0),
    unpriced: rows.some(({ task }) => costUnpriced(task.usage)),
    cost:
      costs.length === 0
        ? null
        : {
            usd: costs.reduce((sum, { usd }) => sum + usd, 0),
            estimate: costs.some(({ estimate }) => estimate),
          },
  };
};

/** A Loop that ran on a Task, with the state of its last Run there. */
export interface TaskLoop {
  readonly loop: LoopName;
  readonly state: RunView["state"];
}

/** The Loops that ran on a Task, each named once in the order they first ran, with the state of
 * each one's last Run. */
export const taskLoops = (task: Pick<BoardTaskView, "runs">): ReadonlyArray<TaskLoop> => {
  // A Map keeps the order of first insertion when a later Run of the same Loop replaces the state.
  const states = new Map<LoopName, RunView["state"]>();
  for (const { loop, state } of task.runs) states.set(loop, state);
  return [...states].map(([loop, state]) => ({ loop, state }));
};

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
