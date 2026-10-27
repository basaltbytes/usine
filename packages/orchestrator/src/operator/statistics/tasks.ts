import { TokenCount, UsdAmount } from "@usine/core/agent/session";
import type { ItemNumber } from "@usine/core/item";
import type { LoopName } from "@usine/core/loop";
import type { RepositoryName } from "@usine/core/repository";
import type { RunId } from "@usine/core/run";
import * as RunState from "@usine/core/run/state";
import type { RunSummary } from "@usine/engine/run-reader";
import { Array as EffectArray, DateTime, Option } from "effect";
import type { RunUsageView } from "../usage.ts";
import { attemptMillis, operatorRetry } from "./runs.ts";
import {
  LoopRunTimeView,
  LoopShareView,
  StatisticsView,
  type StatisticsWindow,
  TaskCostView,
  TaskDoneView,
  TaskPeriodView,
  TaskTimeView,
  TaskTokensView,
  UntimedTasksView,
} from "./view.ts";
import {
  DAY,
  epoch,
  median,
  periodStart,
  periodStarts,
  replacedBeforeStart,
  spanBucket,
  startOfUtcDay,
  sum,
  utcDay,
  windowStart,
} from "./window.ts";

/** A task whose pull request merged, with every Run on its Items. */
export interface MergedTask {
  readonly repository: RepositoryName;
  /** The task's first issue, or its first pull request if it has no issue. */
  readonly number: ItemNumber;
  /** The newest merge among the task's pull requests. */
  readonly mergedAt: DateTime.Utc;
  readonly runs: ReadonlyArray<RunSummary>;
  /** The operator resets of the cycle budgets of the task's Items. */
  readonly budgetResets: number;
}

/** The stored facts that `taskStatisticsView` reduces. */
export interface TaskStatisticsFacts {
  readonly window: StatisticsWindow;
  readonly now: DateTime.Utc;
  /** The tasks merged in the window; the reduction leaves out those merged outside it. */
  readonly tasks: ReadonlyArray<MergedTask>;
  /** The usage of each Run of `tasks`. */
  readonly usage: ReadonlyMap<RunId, RunUsageView>;
}

/** The time a task's Attempts ran per Loop, the rest of its duration, and its closed Runs' times. */
interface TaskTime {
  readonly loops: ReadonlyMap<LoopName, number>;
  readonly waiting: number;
  readonly runs: ReadonlyArray<readonly [LoopName, number]>;
}

/**
 * A task's time: measured, unrecorded because an Attempt ended before usine recorded end times
 * (with the latest such Attempt's start), or empty because the merge came at the first Run's
 * opening.
 */
type TaskTiming =
  | { readonly _tag: "Measured"; readonly time: TaskTime }
  | { readonly _tag: "Unrecorded"; readonly lastStart: number }
  | { readonly _tag: "Empty" };

interface TaskTokens {
  readonly total: number;
  readonly loops: ReadonlyMap<LoopName, number>;
  /** The summed price, or `None` if a session has no price. */
  readonly usd: Option.Option<number>;
  readonly estimate: boolean;
}

interface MeasuredTask {
  readonly view: TaskDoneView;
  readonly start: number;
  readonly mergedAt: number;
  readonly firstTimeRight: boolean;
  readonly operatorActions: number;
  readonly timing: TaskTiming;
  /** The task's tokens, or `None` if a Run with an Attempt reported none. */
  readonly tokens: Option.Option<TaskTokens>;
  /** The task's Loops by their first Run's opening. */
  readonly loops: ReadonlyArray<LoopName>;
}

const loopsByFirstRun = (runs: ReadonlyArray<RunSummary>): ReadonlyArray<LoopName> => {
  const firsts = new Map<LoopName, number>();
  for (const { run } of runs)
    firsts.set(run.loop, Math.min(firsts.get(run.loop) ?? Infinity, epoch(run.openedAt)));
  return [...firsts.entries()]
    .sort(
      ([leftLoop, left], [rightLoop, right]) => left - right || leftLoop.localeCompare(rightLoop),
    )
    .map(([loop]) => loop);
};

/**
 * Whether no Loop succeeded twice on one of the task's Items. A second successful Run of a Loop is
 * a second round (ADR 0022), such as a review after findings; a rebase runs its Loop once.
 */
const firstTimeRight = (runs: ReadonlyArray<RunSummary>): boolean =>
  Object.values(
    EffectArray.groupBy(
      runs.filter(({ run }) => run.state._tag === "Succeeded"),
      ({ itemKey, run }) => JSON.stringify([itemKey, run.loop]),
    ),
  ).every((members) => members.length === 1);

/** Counts the approvals, operator retries, and failures marked resolved on `runs`. */
const runActions = (runs: ReadonlyArray<RunSummary>): number =>
  sum(
    runs.map(
      ({ approval, resolvedFailureAttemptId, attempts }) =>
        Number(Option.isSome(approval)) +
        Number(Option.isSome(resolvedFailureAttemptId)) +
        attempts.filter((attempt) => operatorRetry(attempt)).length,
    ),
  );

/**
 * Splits `[start, end]` into the time each Loop's spans cover and the time none covers. Spans that
 * overlap share the overlap equally.
 */
const splitTime = (
  start: number,
  end: number,
  spans: ReadonlyArray<{ readonly loop: LoopName; readonly from: number; readonly to: number }>,
): Pick<TaskTime, "loops" | "waiting"> => {
  const clipped = spans
    .map(({ loop, from, to }) => ({ loop, from: Math.max(from, start), to: Math.min(to, end) }))
    .filter(({ from, to }) => to > from);
  const bounds = [...new Set([start, end, ...clipped.flatMap(({ from, to }) => [from, to])])].sort(
    (left, right) => left - right,
  );
  const loops = new Map<LoopName, number>();
  let waiting = 0;
  bounds.slice(1).forEach((to, index) => {
    const from = bounds[index] ?? to;
    const covering = clipped.filter((span) => span.from <= from && span.to >= to);
    if (covering.length === 0) waiting += to - from;
    for (const { loop } of covering)
      loops.set(loop, (loops.get(loop) ?? 0) + (to - from) / covering.length);
  });
  return { loops, waiting };
};

/** Returns where the task's time went; a running Attempt counts until `now`. */
const taskTiming = (
  runs: ReadonlyArray<RunSummary>,
  start: number,
  end: number,
  now: number,
): TaskTiming => {
  const unrecorded = runs.flatMap(({ attempts }) =>
    attempts.filter(({ outcome, endedAt }) => Option.isSome(outcome) && Option.isNone(endedAt)),
  );
  if (EffectArray.isReadonlyArrayNonEmpty(unrecorded))
    return {
      _tag: "Unrecorded",
      lastStart: Math.max(...unrecorded.map(({ startedAt }) => epoch(startedAt))),
    };
  if (end <= start) return { _tag: "Empty" };
  const spans = runs.flatMap(({ run, attempts }) =>
    attempts.map((attempt) => ({
      loop: run.loop,
      from: epoch(attempt.startedAt),
      to: Option.match(attempt.endedAt, { onNone: () => now, onSome: epoch }),
    })),
  );
  return {
    _tag: "Measured",
    time: {
      ...splitTime(start, end, spans),
      runs: runs.flatMap(({ run, attempts }) =>
        RunState.isOpen(run.state) || attempts.length === 0
          ? []
          : [
              [
                run.loop,
                sum(attempts.flatMap((attempt) => Option.toArray(attemptMillis(attempt)))),
              ] as const,
            ],
      ),
    },
  };
};

/** Returns the task's tokens, or `None` if a Run with an Attempt has no token report. */
const taskTokens = (
  runs: ReadonlyArray<RunSummary>,
  usage: ReadonlyMap<RunId, RunUsageView>,
): Option.Option<TaskTokens> => {
  const started = runs.filter(({ attempts }) => attempts.length > 0);
  const reported = started.map((summary) => ({
    loop: summary.run.loop,
    sessions: usage.get(summary.run.id)?.sessions ?? [],
  }));
  if (reported.some(({ sessions }) => sessions.length === 0)) return Option.none();
  const loops = new Map<LoopName, number>();
  for (const { loop, sessions } of reported)
    loops.set(loop, (loops.get(loop) ?? 0) + sum(sessions.map(({ tokens }) => tokens)));
  const sessions = reported.flatMap(({ sessions }) => sessions);
  return Option.some({
    total: sum([...loops.values()]),
    loops,
    usd: sessions.every(({ cost }) => cost !== null)
      ? Option.some(sum(sessions.flatMap(({ cost }) => (cost === null ? [] : [cost.usd]))))
      : Option.none(),
    estimate: sessions.some(({ cost }) => cost?.estimate === true),
  });
};

/**
 * Returns the end of usine's work on a task: the last Run's close, or the merge if a Run was still
 * open or closed after it. The wait for the operator to merge a ready pull request is left out.
 */
const workEnd = (runs: ReadonlyArray<RunSummary>, mergedAt: number): number =>
  Math.min(
    mergedAt,
    Math.max(
      ...runs.map(({ closedAt }) =>
        Option.match(closedAt, { onNone: () => mergedAt, onSome: epoch }),
      ),
    ),
  );

const measure = (
  task: MergedTask,
  usage: ReadonlyMap<RunId, RunUsageView>,
  now: number,
): Option.Option<MeasuredTask> => {
  const runs = task.runs.filter((summary) => !replacedBeforeStart(summary));
  if (!EffectArray.isReadonlyArrayNonEmpty(runs)) return Option.none();
  // The Item projection keeps no label times, so the first Run's opening, which the trigger label
  // caused, stands for the label.
  const start = Math.min(...runs.map(({ run }) => epoch(run.openedAt)));
  const mergedAt = epoch(task.mergedAt);
  const end = workEnd(runs, mergedAt);
  const duration = Math.max(0, end - start);
  return Option.some({
    view: new TaskDoneView({
      repository: task.repository,
      number: task.number,
      mergedAt: DateTime.formatIso(task.mergedAt),
      durationMillis: duration,
    }),
    start,
    mergedAt,
    firstTimeRight: firstTimeRight(runs),
    operatorActions: runActions(runs) + task.budgetResets,
    timing: taskTiming(runs, start, end, now),
    tokens: taskTokens(runs, usage),
    loops: loopsByFirstRun(runs),
  });
};

/** Returns the share of each Loop in `parts`, averaged over the tasks, in `order`. */
const meanShares = (
  parts: ReadonlyArray<{ readonly whole: number; readonly loops: ReadonlyMap<LoopName, number> }>,
  order: ReadonlyArray<LoopName>,
): ReadonlyArray<LoopShareView> =>
  parts.length === 0
    ? []
    : order.flatMap((loop) => {
        const share =
          sum(parts.map(({ whole, loops }) => (loops.get(loop) ?? 0) / whole)) / parts.length;
        return share > 0 ? [new LoopShareView({ loop, share: Math.min(1, share) })] : [];
      });

const timeView = (
  times: ReadonlyArray<TaskTime>,
  order: ReadonlyArray<LoopName>,
): TaskTimeView | null => {
  if (times.length === 0) return null;
  const parts = times.map(({ loops, waiting }) => ({
    whole: waiting + sum([...loops.values()]),
    loops,
    waiting,
  }));
  const runs = times.flatMap(({ runs }) => runs);
  return new TaskTimeView({
    tasks: times.length,
    loops: meanShares(parts, order),
    waiting: Math.min(1, sum(parts.map(({ waiting, whole }) => waiting / whole)) / parts.length),
    runs: order.flatMap((loop) => {
      const durations = runs.flatMap(([name, millis]) => (name === loop ? [millis] : []));
      return Option.match(median(durations), {
        onNone: () => [],
        onSome: (middle) => [
          new LoopRunTimeView({ loop, runs: durations.length, medianMillis: Math.round(middle) }),
        ],
      });
    }),
  });
};

const tokensView = (
  tokens: ReadonlyArray<TaskTokens>,
  order: ReadonlyArray<LoopName>,
): TaskTokensView | null =>
  Option.match(median(tokens.map(({ total }) => total)), {
    onNone: () => null,
    onSome: (middle) => {
      const costs = tokens.flatMap(({ usd }) => Option.toArray(usd));
      return new TaskTokensView({
        tasks: tokens.length,
        medianTokens: TokenCount.make(Math.round(middle)),
        loops: meanShares(
          tokens.flatMap(({ total, loops }) => (total > 0 ? [{ whole: total, loops }] : [])),
          order,
        ),
        cost: Option.match(median(costs), {
          onNone: () => null,
          onSome: (usd) =>
            new TaskCostView({
              tasks: costs.length,
              medianUsd: UsdAmount.make(usd),
              estimate: tokens.some(({ usd, estimate }) => Option.isSome(usd) && estimate),
            }),
        }),
      });
    },
  });

/** Returns the Loops of `tasks` as `StatisticsView.loops` orders them. */
const pipelineOrder = (tasks: ReadonlyArray<MeasuredTask>): ReadonlyArray<LoopName> => {
  const ranks = new Map<LoopName, Array<number>>();
  for (const { loops } of tasks)
    loops.forEach((loop, index) => {
      const ranked = ranks.get(loop) ?? [];
      if (loops.length > 1) ranked.push(index / (loops.length - 1));
      ranks.set(loop, ranked);
    });
  return [...ranks.entries()]
    .map(([loop, values]) => ({
      loop,
      rank: values.length === 0 ? 0 : sum(values) / values.length,
    }))
    .sort((left, right) => left.rank - right.rank || left.loop.localeCompare(right.loop))
    .map(({ loop }) => loop);
};

/** Reduces the merged tasks to the statistics of `window`. */
export const taskStatisticsView = ({
  window,
  now,
  tasks: merged,
  usage,
}: TaskStatisticsFacts): StatisticsView => {
  const to = epoch(now);
  const measured = merged.flatMap((task) => Option.toArray(measure(task, usage, to)));
  const from = Option.match(windowStart(window, now), {
    onSome: epoch,
    onNone: () =>
      startOfUtcDay(measured.reduce((earliest, { start }) => Math.min(earliest, start), to)),
  });
  const tasks = measured
    .filter(({ mergedAt }) => mergedAt >= from && mergedAt <= to)
    .sort((left, right) => left.mergedAt - right.mergedAt);
  const bucket = spanBucket(from, to);
  const order = pipelineOrder(tasks);
  const times = tasks.flatMap(({ timing }) => (timing._tag === "Measured" ? [timing.time] : []));
  const untimed = tasks.flatMap(({ timing }) =>
    timing._tag === "Unrecorded" ? [timing.lastStart] : [],
  );
  const metered = tasks.flatMap(({ tokens }) => Option.toArray(tokens));
  const durations = (members: ReadonlyArray<MeasuredTask>) =>
    Option.getOrNull(
      Option.map(median(members.map(({ view }) => view.durationMillis)), Math.round),
    );
  return new StatisticsView({
    window,
    from: new Date(from).toISOString(),
    to: DateTime.formatIso(now),
    bucket,
    loops: order,
    tasks: tasks.map(({ view }) => view),
    medianMillis: durations(tasks),
    periods: periodStarts(bucket, from, to).map((start) => {
      const members = tasks.filter(({ mergedAt }) => periodStart(bucket, mergedAt) === start);
      return new TaskPeriodView({
        start: utcDay(start),
        tasks: members.length,
        medianMillis: durations(members),
        firstTimeRight: members.filter(({ firstTimeRight }) => firstTimeRight).length,
        operatorActions: sum(members.map(({ operatorActions }) => operatorActions)),
      });
    }),
    firstTimeRight: tasks.filter(({ firstTimeRight }) => firstTimeRight).length,
    operatorActions: sum(tasks.map(({ operatorActions }) => operatorActions)),
    time: timeView(times, order),
    tokens: tokensView(metered, order),
    untimed: EffectArray.isReadonlyArrayNonEmpty(untimed)
      ? new UntimedTasksView({
          tasks: untimed.length,
          before: utcDay(startOfUtcDay(Math.max(...untimed)) + DAY),
        })
      : null,
    unmetered: tasks.length - metered.length,
  });
};
