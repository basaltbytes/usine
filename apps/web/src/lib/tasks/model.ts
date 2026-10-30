import { isSettledItemState } from "@usine/config/board";
import type { LoopName } from "@usine/core/loop";
import type { CommentKind } from "@usine/core/step/result";
import type {
  BoardLaneView,
  BoardTaskView,
  FailureView,
  RunView,
  StalledItemView,
  TaskUsageView,
} from "@usine/orchestrator/operator";
import { Match, Option } from "effect";
import { cardIdentity } from "~/components/item/identity";
import { durationLabel, tokensLabel, usdLabel } from "~/lib/strings";

/**
 * Returns the total Attempt time of a Run: each ended Attempt from start to end, and a running
 * Attempt up to `now`. Returns `None` if no Attempt started or an ended Attempt has no recorded end.
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

/** Returns the failure of a Failed Run's latest Attempt, or `None` for any other Run. */
export const runFailure = (
  run: Pick<RunView, "state" | "attempts">,
): Option.Option<FailureView> => {
  const outcome = run.attempts.at(-1)?.outcome;
  return run.state === "Failed" && outcome?._tag === "Failed"
    ? Option.some(outcome.failure)
    : Option.none();
};

/** Returns when a Run was last active: its close time if it is closed; otherwise its last Attempt's
 * end, that Attempt's start while it runs or if no end was recorded, or the Run's open time before
 * any Attempt. */
export const runActivityAt = (run: Pick<RunView, "attempts" | "openedAt" | "closedAt">): string => {
  const last = run.attempts.at(-1);
  return run.closedAt ?? last?.endedAt ?? last?.startedAt ?? run.openedAt;
};

/** Returns the desk's stall entries for the Task's Items in desk order, one per Loop and Item. */
const taskStalls = (
  stalled: ReadonlyArray<StalledItemView>,
  task: Pick<BoardTaskView, "items">,
): ReadonlyArray<StalledItemView> => {
  const keys = new Set(task.items.map(({ itemKey }) => itemKey));
  return stalled.filter(({ item }) => keys.has(item.itemKey));
};

/** Returns the first desk stall entry for one of the Task's Items, or `null`. */
export const taskStall = (
  stalled: ReadonlyArray<StalledItemView>,
  task: Pick<BoardTaskView, "items">,
): StalledItemView | null => taskStalls(stalled, task)[0] ?? null;

/** Returns the Run that a stall reason references, or `null` if the reason is only about the Loop
 * or the Item, such as a paused Loop, a used-up cycle budget, or a pending poll. */
export const stallRun = ({ reason }: Pick<StalledItemView, "reason">): RunView | null =>
  "run" in reason ? reason.run : null;

/** Returns the number in the Task page URL, which is the originating item's number. */
export const taskNumber = (task: BoardTaskView): string => String(cardIdentity(task).origin.number);

/**
 * The Task's status in the Tasks list. `Running`, `AwaitingApproval`, `Queued`, and `Stalled` are in
 * flight, each with the Run whose open time orders it (see `rowPlace` and `countedAs`).
 */
type TaskStatus =
  /** `run` has a running Attempt. */
  | { readonly _tag: "Running"; readonly run: RunView }
  /** `run` is waiting for approval. */
  | { readonly _tag: "AwaitingApproval"; readonly run: RunView }
  /** `run` is pending or queued, and the desk has no reason for it yet. */
  | { readonly _tag: "Queued"; readonly run: RunView }
  /**
   * A Loop's trigger matches one of the Task's Items with no running Attempt, and `stall` is the
   * first stall in desk order that keeps the work in flight (see `keepsInFlight`). `run` is the Run
   * the reason references, else the open pending or queued Run, else the last Run.
   */
  | { readonly _tag: "Stalled"; readonly stall: StalledItemView; readonly run: RunView }
  /**
   * A Loop's trigger matches one of the Task's Items, but no Run is open and no stall needs the
   * operator: the last Run closed on the unchanged Item, the next poll handles it, the Loop is
   * paused, or the failure is resolved. `stall` is the first stall in desk order.
   */
  | { readonly _tag: "Idle"; readonly stall: StalledItemView }
  /** Nothing is open or stalled, and a failed Run or a suppression of one of the Items needs the
   * operator, as on the Board card. */
  | { readonly _tag: "NeedsAttention" }
  /** The current Item is merged or closed and no Run is open. */
  | { readonly _tag: "Done" }
  /** Nothing is open, stalled, or needs the operator; the status is the last Run's outcome. */
  | { readonly _tag: "Ended"; readonly run: RunView };

/** A Tasks list row for a Task that usine ran at least once. */
export interface TaskRow {
  readonly task: BoardTaskView;
  /** The Task's latest Run; the Status column shows its last activity time. */
  readonly last: RunView;
  readonly status: TaskStatus;
}

/**
 * Returns whether `stall` keeps its Task in flight: its reason references an open Run, or stalls the
 * Loop until the operator acts, as for a question, a blocker, a used-up cycle budget, or an
 * unresolved failure. A paused Loop keeps a Task in flight only with an open Run, which `taskStatus`
 * checks before stalls.
 */
const keepsInFlight = ({ reason }: StalledItemView): boolean =>
  Match.valueTags(reason, {
    AwaitingApproval: () => true,
    WaitingForStop: () => true,
    QueuedForWorker: () => true,
    WaitingForUpgrade: () => true,
    SuppressedForOperator: () => true,
    CycleBudgetUsedUp: () => true,
    RunFailed: ({ run }) => run.canResolveFailure,
    ClosedUnchanged: () => false,
    LoopPaused: () => false,
    AwaitingPoll: () => false,
  });

const newestIn = (
  runs: ReadonlyArray<RunView>,
  ...states: ReadonlyArray<RunView["state"]>
): RunView | undefined => [...runs].reverse().find(({ state }) => states.includes(state));

/**
 * Returns the first status that applies: a running Run, a Run waiting for approval, a pending or
 * queued Run with the desk's reason for it, `Done` for a merged or closed current Item, a stall that
 * keeps the work in flight, any other stall as `Idle`, `NeedsAttention`, and finally the outcome of
 * `last`.
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
    // The desk has one stall per Loop and Item, and a stall for an older closed Run on another Item
    // can come first; only the stall that references the queued Run explains it.
    const own = stalled.find((stall) => stallRun(stall)?.id === queued.id);
    return own === undefined
      ? { _tag: "Queued", run: queued }
      : { _tag: "Stalled", stall: own, run: queued };
  }
  if (isSettledItemState(task.state)) return { _tag: "Done" };
  // The desk orders failures by Item and Loop, not by resolution, so a resolved failure can come
  // before another Loop's unresolved one. A stall that keeps the work in flight takes precedence.
  const stalls = taskStalls(stalled, task);
  const open = stalls.find(keepsInFlight);
  if (open !== undefined) return { _tag: "Stalled", stall: open, run: stallRun(open) ?? last };
  const [idle] = stalls;
  if (idle !== undefined) return { _tag: "Idle", stall: idle };
  if (task.needsYou) return { _tag: "NeedsAttention" };
  return { _tag: "Ended", run: last };
};

/**
 * Returns a row's group and its sort time within the group, newest first. In-flight rows come first:
 * running, then waiting for approval, then pending, queued, and stalled, each by Run open time. All
 * other Tasks, idle ones included, follow by last Run close time, which for a Run canceled before any
 * Attempt is the cancel time.
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
    case "Idle":
    case "NeedsAttention":
    case "Done":
    case "Ended":
      return [3, Date.parse(runActivityAt(last))];
  }
};

/**
 * Returns the Tasks list rows for the Tasks in `lanes` that have at least one Run, in `rowPlace`
 * order; ties go to the higher current Item number. `stalled` is the desk's list of stalled Items.
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

const HEADING_COUNTS = ["in flight", "needs attention", "done"] as const;

/**
 * Returns the heading count that a row adds to; `null` for a Task that shows its last Run's outcome,
 * and for an idle Task unless a failed Run or a suppression of one of its Items needs the
 * operator.
 */
const countedAs = ({ task, status }: TaskRow): (typeof HEADING_COUNTS)[number] | null => {
  switch (status._tag) {
    case "Running":
    case "AwaitingApproval":
    case "Queued":
    case "Stalled":
      return "in flight";
    case "Idle":
      return task.needsYou ? "needs attention" : null;
    case "NeedsAttention":
      return "needs attention";
    case "Done":
      return "done";
    case "Ended":
      return null;
  }
};

/**
 * Returns the Tasks list heading counts, for example `2 in flight, 1 needs attention, 2 done`,
 * without zero counts; `undefined` if all are zero.
 */
export const taskCounts = (rows: ReadonlyArray<TaskRow>): string | undefined => {
  const shown = HEADING_COUNTS.flatMap((what) => {
    const count = rows.filter((row) => countedAs(row) === what).length;
    return count === 0 ? [] : [`${count} ${what}`];
  });
  return shown.length === 0 ? undefined : shown.join(", ");
};

/**
 * Returns the Task's Attempt time at `now`: the ended Attempts' time plus each running Attempt from
 * its start to `now`.
 */
export const taskDuration = (
  usage: Pick<TaskUsageView, "durationMillis" | "runningSince">,
  now: number,
): number =>
  usage.runningSince.reduce(
    (total, since) => total + Math.max(0, now - Date.parse(since)),
    usage.durationMillis,
  );

/** Returns whether some of the Task's usage has no price yet, so the cost is a lower bound. */
export const costUnpriced = (usage: Pick<TaskUsageView, "pools">): boolean =>
  usage.pools.some(({ unpriced }) => unpriced);

/** The totals of the listed Tasks, shown under the Tasks list heading. */
export interface TaskTotals {
  readonly runs: number;
  readonly durationMillis: number;
  /** The number of ended Attempts with no recorded end; `durationMillis` excludes them. */
  readonly unmeasured: number;
  readonly tokens: number;
  /** The total cost in dollars of the priced Tasks, or `null` if no Task has a price. */
  readonly usd: number | null;
  /** Whether a listed Task has usage with no price yet, so `usd` is a lower bound. */
  readonly unpriced: boolean;
}

/** Returns the totals of Runs, Attempt time at `now`, tokens, and dollars over all rows. */
export const taskTotals = (rows: ReadonlyArray<TaskRow>, now: number): TaskTotals => {
  const costs = rows.flatMap(({ task }) => (task.usage.cost === null ? [] : [task.usage.cost]));
  return {
    runs: rows.reduce((sum, { task }) => sum + task.runs.length, 0),
    durationMillis: rows.reduce((sum, { task }) => sum + taskDuration(task.usage, now), 0),
    unmeasured: rows.reduce((sum, { task }) => sum + task.usage.unmeasured, 0),
    tokens: rows.reduce((sum, { task }) => sum + task.usage.tokens, 0),
    unpriced: rows.some(({ task }) => costUnpriced(task.usage)),
    usd: costs.length === 0 ? null : costs.reduce((sum, { usd }) => sum + usd, 0),
  };
};

/** The reason an elapsed time marked `*` is lower than the real one. */
export const untimedNote = "Some attempts have no recorded timing; the real figure is higher";

/** The reason an estimated cost marked `*` is lower than the real one. */
export const unpricedNote = "Some sessions have no price yet; the real figure is higher";

/**
 * A figure in the totals line and the words after it, for example `12 h 8 min` and `elapsed`.
 * `lowerBound` is the reason the real figure is higher, or `null` if the figure is complete.
 */
export interface TotalsFigure {
  readonly figure: string;
  readonly words: string;
  readonly lowerBound: string | null;
}

/**
 * Returns the figures of the totals line, for example
 * `197 runs, 12 h 8 min* elapsed, 127.5M tokens, $134.34* estimated`; the cost is omitted if no Task
 * has a price.
 */
export const totalsFigures = (totals: TaskTotals): ReadonlyArray<TotalsFigure> => [
  { figure: String(totals.runs), words: totals.runs === 1 ? "run" : "runs", lowerBound: null },
  {
    figure: durationLabel(totals.durationMillis),
    words: "elapsed",
    lowerBound: totals.unmeasured > 0 ? untimedNote : null,
  },
  { figure: tokensLabel(totals.tokens), words: "tokens", lowerBound: null },
  ...(totals.usd === null
    ? []
    : [
        {
          figure: usdLabel(totals.usd),
          words: "estimated",
          lowerBound: totals.unpriced ? unpricedNote : null,
        },
      ]),
];

/** A Loop that ran on a Task, with the state of its last Run there. */
export interface TaskLoop {
  readonly loop: LoopName;
  readonly state: RunView["state"];
}

/** Returns each Loop that ran on the Task once, in first-run order, with the state of its last Run. */
export const taskLoops = (task: Pick<BoardTaskView, "runs">): ReadonlyArray<TaskLoop> => {
  // A Map keeps the order of first insertion when a later Run of the same Loop replaces the state.
  const states = new Map<LoopName, RunView["state"]>();
  for (const { loop, state } of task.runs) states.set(loop, state);
  return [...states].map(([loop, state]) => ({ loop, state }));
};

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
