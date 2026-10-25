import type { BillingPool } from "@usine/core/agent/session";
import { TokenCount, UsdAmount } from "@usine/core/agent/session";
import type { Attempt } from "@usine/core/attempt";
import type { RunId } from "@usine/core/run";
import * as RunState from "@usine/core/run/state";
import type { WorkerName } from "@usine/core/worker";
import type { RunSummary } from "@usine/engine/run-reader";
import { Array as EffectArray, DateTime, Option, Order } from "effect";
import type { RunUsageView, SessionUsageView } from "../usage.ts";
import {
  AgentStatisticsView,
  AttemptCountView,
  BrainStatisticsView,
  CostSummaryView,
  DurationSummaryView,
  FirstPassView,
  LoopStatisticsView,
  NeedsAttentionPeriodView,
  NeedsAttentionView,
  OutcomeCountsView,
  PoolTokensView,
  type StatisticsBucket,
  StatisticsView,
  type StatisticsWindow,
  ThroughputPeriodView,
  UsageSummaryView,
  WorkerQueueWaitView,
  WorkerUtilizationView,
} from "./view.ts";

const DAY = 86_400_000;
const WEEK = 7 * DAY;
/** The longest span, in days, that the time series still split into days. */
const DAILY_SPAN_DAYS = 62;
const WINDOW_DAYS = { "7d": 7, "30d": 30 } as const;
const POOLS: ReadonlyArray<BillingPool> = ["apiKeys", "claudePlan", "chatgptPlan"];

/** A pull request merge and every Run on the Items of its Task. */
export interface PullRequestMerge {
  readonly mergedAt: DateTime.Utc;
  readonly runs: ReadonlyArray<RunSummary>;
}

/** A Worker that `usine.yaml` declares, with its `max_concurrent_attempts`. */
interface DeclaredWorker {
  readonly name: WorkerName;
  readonly slots: number;
}

/** The stored facts that `statisticsView` reduces. */
export interface StatisticsFacts {
  readonly window: StatisticsWindow;
  readonly now: DateTime.Utc;
  /** The Runs that closed in the window and the open Runs. */
  readonly runs: ReadonlyArray<RunSummary>;
  /** The usage of each closed Run in `runs`. */
  readonly usage: ReadonlyMap<RunId, RunUsageView>;
  readonly merges: ReadonlyArray<PullRequestMerge>;
  readonly workers: ReadonlyArray<DeclaredWorker>;
}

const startOfUtcDay = (epochMillis: number): number => epochMillis - (epochMillis % DAY);

/** Returns the start of `window`, or `None` for `all`, whose start depends on the stored Runs. */
export const windowStart = (
  window: StatisticsWindow,
  now: DateTime.Utc,
): Option.Option<DateTime.Utc> =>
  window === "all"
    ? Option.none()
    : Option.some(
        DateTime.makeUnsafe(
          startOfUtcDay(DateTime.toEpochMillis(now)) - (WINDOW_DAYS[window] - 1) * DAY,
        ),
      );

/**
 * Whether the engine canceled the Run before any Attempt because a newer Event or an Item change
 * replaced it.
 */
const replacedBeforeStart = ({ run, attempts }: RunSummary): boolean =>
  attempts.length === 0 &&
  run.state._tag === "Canceled" &&
  run.state.reason._tag !== "OperatorCanceled";

const epoch = DateTime.toEpochMillis;

/** Returns when a closed Run closed; the fallback only covers the nullable stored field. */
const closedAt = (summary: RunSummary): number =>
  Option.match(summary.closedAt, {
    onSome: epoch,
    onNone: () => {
      const last = summary.attempts.at(-1);
      return last === undefined
        ? epoch(summary.run.openedAt)
        : Option.match(last.endedAt, {
            onSome: epoch,
            onNone: () => epoch(last.startedAt),
          });
    },
  });

const sum = (values: ReadonlyArray<number>): number =>
  values.reduce((total, value) => total + value, 0);

const quantile = (sorted: EffectArray.NonEmptyReadonlyArray<number>, q: number): number => {
  const position = (sorted.length - 1) * q;
  const lower = sorted[Math.floor(position)] ?? sorted[0];
  const upper = sorted[Math.ceil(position)] ?? lower;
  return lower + (upper - lower) * (position - Math.floor(position));
};

/** Returns the mean, median, and 90th percentile of `durations`, or null if there are none. */
export const durationSummary = (durations: ReadonlyArray<number>): DurationSummaryView | null => {
  if (!EffectArray.isReadonlyArrayNonEmpty(durations)) return null;
  const sorted = EffectArray.sort(durations, Order.Number);
  return new DurationSummaryView({
    count: sorted.length,
    meanMillis: Math.round(sum(sorted) / sorted.length),
    medianMillis: Math.round(quantile(sorted, 0.5)),
    p90Millis: Math.round(quantile(sorted, 0.9)),
  });
};

type Outcome = "succeeded" | "failed" | "canceled";

const runOutcome = (summary: RunSummary): Outcome | null => {
  switch (summary.run.state._tag) {
    case "Succeeded":
      return "succeeded";
    case "Failed":
      return "failed";
    case "Canceled":
      return "canceled";
    default:
      return null;
  }
};

const attemptOutcome = (attempt: Attempt): Outcome | null =>
  Option.match(attempt.outcome, {
    onNone: () => null,
    onSome: ({ _tag }) =>
      _tag === "Succeeded" ? "succeeded" : _tag === "Failed" ? "failed" : "canceled",
  });

const outcomeCounts = (outcomes: ReadonlyArray<Outcome | null>): OutcomeCountsView =>
  new OutcomeCountsView({
    succeeded: outcomes.filter((outcome) => outcome === "succeeded").length,
    failed: outcomes.filter((outcome) => outcome === "failed").length,
    canceled: outcomes.filter((outcome) => outcome === "canceled").length,
  });

/** Returns the Attempt's wall time, or `None` while it runs or if its end wasn't recorded. */
const attemptMillis = (attempt: Attempt): Option.Option<number> =>
  Option.isNone(attempt.outcome)
    ? Option.none()
    : Option.map(attempt.endedAt, (endedAt) =>
        Math.max(0, epoch(endedAt) - epoch(attempt.startedAt)),
      );

const runMillis = (summary: RunSummary): number =>
  Math.max(0, closedAt(summary) - epoch(summary.run.openedAt));

/**
 * Sums the tokens and prices of `units`, each the sessions of one Run or Attempt. A unit is priced
 * if it has a session in a pool with a dollar rate and each such session has a price; ChatGPT plan
 * sessions have no dollar rate, so they add tokens but no cost.
 */
const usageSummary = (units: ReadonlyArray<ReadonlyArray<SessionUsageView>>): UsageSummaryView => {
  const sessions = units.flat();
  const tokens = sum(sessions.map((session) => session.tokens));
  const priced = units.filter((unit) => {
    const rated = unit.filter(({ pool }) => pool !== "chatgptPlan");
    return rated.length > 0 && rated.every(({ cost }) => cost !== null);
  });
  const usd = sum(
    priced.flatMap((unit) => unit.flatMap(({ cost }) => (cost === null ? [] : [cost.usd]))),
  );
  return new UsageSummaryView({
    measured: units.length,
    tokens: TokenCount.make(tokens),
    meanTokens: units.length === 0 ? null : TokenCount.make(Math.round(tokens / units.length)),
    pools: POOLS.flatMap((pool) => {
      const members = sessions.filter((session) => session.pool === pool);
      return members.length === 0
        ? []
        : [
            new PoolTokensView({
              pool,
              tokens: TokenCount.make(sum(members.map((session) => session.tokens))),
            }),
          ];
    }),
    cost:
      priced.length === 0
        ? null
        : new CostSummaryView({
            usd: UsdAmount.make(usd),
            meanUsd: UsdAmount.make(usd / priced.length),
            estimate: priced.some((unit) => unit.some(({ cost }) => cost?.estimate === true)),
            priced: priced.length,
          }),
  });
};

const runSessions = (
  summary: RunSummary,
  usage: ReadonlyMap<RunId, RunUsageView>,
): ReadonlyArray<SessionUsageView> => usage.get(summary.run.id)?.sessions ?? [];

/** Returns the closed Runs grouped by `key`, the largest group first, then by key. */
const groupRuns = <K extends string>(
  runs: ReadonlyArray<RunSummary>,
  key: (summary: RunSummary) => K,
): ReadonlyArray<readonly [K, EffectArray.NonEmptyReadonlyArray<RunSummary>]> =>
  Object.values<EffectArray.NonEmptyArray<RunSummary>>(EffectArray.groupBy(runs, key))
    .map((members) => [key(members[0]), members] as const)
    .sort(
      ([leftName, left], [rightName, right]) =>
        right.length - left.length || leftName.localeCompare(rightName),
    );

const runGroup = (runs: ReadonlyArray<RunSummary>, usage: ReadonlyMap<RunId, RunUsageView>) => ({
  outcomes: outcomeCounts(runs.map(runOutcome)),
  time: durationSummary(runs.map(runMillis)),
  usage: usageSummary(
    runs
      .filter(({ attempts }) => attempts.length > 0)
      .map((summary) => runSessions(summary, usage)),
  ),
});

const brainGroups = (
  runs: ReadonlyArray<RunSummary>,
  usage: ReadonlyMap<RunId, RunUsageView>,
): ReadonlyArray<BrainStatisticsView> => {
  const ended = runs.flatMap((summary) =>
    summary.attempts
      .filter((attempt) => Option.isSome(attempt.outcome))
      .map((attempt) => ({
        attempt,
        sessions: runSessions(summary, usage).filter(({ attemptId }) => attemptId === attempt.id),
      })),
  );
  const groups = EffectArray.groupBy(ended, ({ attempt: { brain } }) =>
    JSON.stringify([brain.harness, brain.model, brain.effort]),
  );
  return Object.values(groups)
    .map(
      (members) =>
        new BrainStatisticsView({
          brain: members[0].attempt.brain,
          outcomes: outcomeCounts(members.map(({ attempt }) => attemptOutcome(attempt))),
          time: durationSummary(
            members.flatMap(({ attempt }) => Option.toArray(attemptMillis(attempt))),
          ),
          usage: usageSummary(members.map(({ sessions }) => sessions)),
        }),
    )
    .sort(
      (left, right) =>
        right.outcomes.succeeded +
          right.outcomes.failed +
          right.outcomes.canceled -
          (left.outcomes.succeeded + left.outcomes.failed + left.outcomes.canceled) ||
        left.brain.harness.localeCompare(right.brain.harness) ||
        left.brain.model.localeCompare(right.brain.model) ||
        left.brain.effort.localeCompare(right.brain.effort),
    );
};

const utcDay = (epochMillis: number): string => new Date(epochMillis).toISOString().slice(0, 10);

/** Returns the start of the period that holds `epochMillis`. Weeks start on Monday. */
const periodStart = (bucket: StatisticsBucket, epochMillis: number): number => {
  const day = startOfUtcDay(epochMillis);
  return bucket === "day" ? day : day - ((new Date(day).getUTCDay() + 6) % 7) * DAY;
};

/** Returns the start of each period from `from` to `to`, oldest first. */
const periodStarts = (
  bucket: StatisticsBucket,
  from: number,
  to: number,
): ReadonlyArray<number> => {
  const step = bucket === "day" ? DAY : WEEK;
  const starts: Array<number> = [];
  for (let start = periodStart(bucket, from); start <= to; start += step) starts.push(start);
  return starts;
};

/** Counts `instants` per period of `starts`; instants outside every period are left out. */
const perPeriod = (
  bucket: StatisticsBucket,
  starts: ReadonlyArray<number>,
  instants: ReadonlyArray<number>,
): ReadonlyMap<number, number> => {
  const counts = new Map(starts.map((start) => [start, 0]));
  for (const instant of instants) {
    const start = periodStart(bucket, instant);
    const count = counts.get(start);
    if (count !== undefined) counts.set(start, count + 1);
  }
  return counts;
};

/** Whether each Run of a Loop on one of the Task's Items is the only one. */
const onePass = (runs: ReadonlyArray<RunSummary>): boolean =>
  Object.values(
    EffectArray.groupBy(runs, ({ itemKey, run }) => JSON.stringify([itemKey, run.loop])),
  ).every((members) => members.length === 1);

const firstAttempt = (summary: RunSummary): Attempt | undefined =>
  summary.attempts.reduce<Attempt | undefined>(
    (first, attempt) => (first === undefined || attempt.number < first.number ? attempt : first),
    undefined,
  );

const automaticRestart = (attempt: Attempt | undefined): boolean =>
  attempt !== undefined &&
  Option.exists(attempt.start, ({ _tag }) => _tag === "InfraRetry" || _tag === "AfterRestart");

const operatorRetry = (attempt: Attempt | undefined): attempt is Attempt =>
  attempt !== undefined &&
  Option.exists(attempt.start, ({ _tag }) => _tag === "OperatorRetry" || _tag === "EditAndRetry");

/**
 * Returns the approvals asked for and the failures raised in the window, from the Runs' openings,
 * approvals, and Attempts.
 */
const needsAttention = (
  runs: ReadonlyArray<RunSummary>,
  from: number,
  bucket: StatisticsBucket,
  starts: ReadonlyArray<number>,
): NeedsAttentionView => {
  const approvals: Array<number> = [];
  const approvalWaits: Array<number> = [];
  const failures: Array<number> = [];
  const retryWaits: Array<number> = [];
  for (const summary of runs) {
    const opened = epoch(summary.run.openedAt);
    if (opened >= from) {
      Option.match(summary.approval, {
        onNone: () => {
          if (summary.run.state._tag === "Waiting") approvals.push(opened);
        },
        onSome: ({ approvedAt }) => {
          approvals.push(opened);
          approvalWaits.push(Math.max(0, epoch(approvedAt) - opened));
        },
      });
    }
    const ordered = [...summary.attempts].sort((left, right) => left.number - right.number);
    ordered.forEach((attempt, index) => {
      const failed = Option.exists(attempt.outcome, ({ _tag }) => _tag === "Failed");
      if (!failed || Option.isNone(attempt.endedAt)) return;
      const ended = epoch(attempt.endedAt.value);
      const next = ordered[index + 1];
      if (ended < from || automaticRestart(next)) return;
      failures.push(ended);
      if (operatorRetry(next)) retryWaits.push(Math.max(0, epoch(next.startedAt) - ended));
    });
  }
  const approvalCounts = perPeriod(bucket, starts, approvals);
  const failureCounts = perPeriod(bucket, starts, failures);
  return new NeedsAttentionView({
    approvals: approvals.length,
    failures: failures.length,
    periods: starts.map(
      (start) =>
        new NeedsAttentionPeriodView({
          start: utcDay(start),
          approvals: approvalCounts.get(start) ?? 0,
          failures: failureCounts.get(start) ?? 0,
        }),
    ),
    approvalWait: durationSummary(approvalWaits),
    retryWait: durationSummary(retryWaits),
  });
};

/**
 * Reduces the stored facts to the statistics of `window`. Run measures cover the Runs that closed
 * in the window; queue wait, Worker utilization, and Needs attention also cover the open Runs.
 */
export const statisticsView = ({
  window,
  now,
  runs: stored,
  usage,
  merges,
  workers,
}: StatisticsFacts): StatisticsView => {
  const to = epoch(now);
  const runs = stored.filter((summary) => !replacedBeforeStart(summary));
  const from = Option.match(windowStart(window, now), {
    onSome: epoch,
    onNone: () =>
      startOfUtcDay(
        runs.reduce(
          (earliest, { run, attempts }) =>
            attempts.reduce(
              (first, { startedAt }) => Math.min(first, epoch(startedAt)),
              Math.min(earliest, epoch(run.openedAt)),
            ),
          to,
        ),
      ),
  });
  const closed = runs.filter(({ run }) => !RunState.isOpen(run.state));
  const spanDays = (startOfUtcDay(to) - from) / DAY + 1;
  const bucket: StatisticsBucket = spanDays <= DAILY_SPAN_DAYS ? "day" : "week";
  const starts = periodStarts(bucket, from, to);

  const throughputCounts = new Map(
    starts.map((start) => [start, { succeeded: 0, failed: 0, canceled: 0 }]),
  );
  for (const summary of closed) {
    const outcome = runOutcome(summary);
    const period = throughputCounts.get(periodStart(bucket, closedAt(summary)));
    if (outcome !== null && period !== undefined) period[outcome] += 1;
  }

  const ended = closed.flatMap(({ attempts }) =>
    attempts.filter(({ outcome }) => Option.isSome(outcome)),
  );

  const counted = merges.flatMap(({ mergedAt, runs: taskRuns }) => {
    const merged = epoch(mergedAt);
    const task = taskRuns.filter((summary) => !replacedBeforeStart(summary));
    if (merged < from || merged > to || !EffectArray.isReadonlyArrayNonEmpty(task)) return [];
    const opened = task.reduce(
      (earliest, { run }) => Math.min(earliest, epoch(run.openedAt)),
      Number.POSITIVE_INFINITY,
    );
    return [{ leadMillis: Math.max(0, merged - opened), firstPass: onePass(task) }];
  });

  const waits = new Map<WorkerName, Array<number>>();
  for (const summary of runs) {
    const first = firstAttempt(summary);
    if (first === undefined || epoch(first.startedAt) < from) continue;
    const ready = Math.max(
      epoch(summary.run.openedAt),
      Option.match(summary.approval, {
        onNone: () => 0,
        onSome: ({ approvedAt }) => epoch(approvedAt),
      }),
    );
    const worker = waits.get(first.worker) ?? [];
    worker.push(Math.max(0, epoch(first.startedAt) - ready));
    waits.set(first.worker, worker);
  }

  const attemptCounts = closed.flatMap(({ attempts }) =>
    attempts.length === 0 ? [] : [attempts.length],
  );
  const mostAttempts = attemptCounts.reduce((most, count) => Math.max(most, count), 0);

  const windowMillis = Math.max(0, to - from);
  const occupied = (worker: WorkerName): number =>
    sum(
      runs.flatMap(({ attempts }) =>
        attempts
          .filter((attempt) => attempt.worker === worker)
          .flatMap((attempt) => {
            const end = Option.isNone(attempt.outcome)
              ? Option.some(to)
              : Option.map(attempt.endedAt, epoch);
            return Option.toArray(
              Option.map(end, (until) =>
                Math.max(0, Math.min(until, to) - Math.max(epoch(attempt.startedAt), from)),
              ),
            );
          }),
      ),
    );

  return new StatisticsView({
    window,
    from: new Date(from).toISOString(),
    to: DateTime.formatIso(now),
    bucket,
    runs: outcomeCounts(closed.map(runOutcome)),
    runTime: durationSummary(closed.map(runMillis)),
    attemptTime: durationSummary(
      ended.flatMap((attempt) => Option.toArray(attemptMillis(attempt))),
    ),
    unmeasuredAttempts: ended.filter(({ endedAt }) => Option.isNone(endedAt)).length,
    usage: runGroup(closed, usage).usage,
    throughput: starts.map(
      (start) =>
        new ThroughputPeriodView({
          start: utcDay(start),
          ...(throughputCounts.get(start) ?? { succeeded: 0, failed: 0, canceled: 0 }),
        }),
    ),
    firstPass: new FirstPassView({
      merged: counted.length,
      firstPass: counted.filter(({ firstPass }) => firstPass).length,
    }),
    leadTime: durationSummary(counted.map(({ leadMillis }) => leadMillis)),
    loops: groupRuns(closed, ({ run }) => run.loop).map(
      ([loop, members]) => new LoopStatisticsView({ loop, ...runGroup(members, usage) }),
    ),
    agents: groupRuns(closed, ({ agent }) => agent.name).map(
      ([agent, members]) => new AgentStatisticsView({ agent, ...runGroup(members, usage) }),
    ),
    brains: brainGroups(closed, usage),
    queueWait: [...waits.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .flatMap(([worker, durations]) => {
        const wait = durationSummary(durations);
        return wait === null ? [] : [new WorkerQueueWaitView({ worker, wait })];
      }),
    attemptsPerRun: Array.from(
      { length: mostAttempts },
      (_, index) =>
        new AttemptCountView({
          attempts: index + 1,
          runs: attemptCounts.filter((count) => count === index + 1).length,
        }),
    ),
    utilization: workers.flatMap(({ name, slots }) => {
      if (slots < 1) return [];
      const held = occupied(name);
      return [
        new WorkerUtilizationView({
          worker: name,
          slots,
          occupiedMillis: Math.round(held),
          share: windowMillis === 0 ? 0 : Math.min(1, held / (slots * windowMillis)),
        }),
      ];
    }),
    needsAttention: needsAttention(runs, from, bucket, starts),
  });
};
