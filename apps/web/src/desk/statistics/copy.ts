import type {
  AttemptCountView,
  DurationSummaryView,
  FirstPassView,
  NeedsAttentionView,
  OutcomeCountsView,
  StatisticsBucket,
  StatisticsWindow,
  ThroughputPeriodView,
  UsageSummaryView,
  WorkerQueueWaitView,
  WorkerUtilizationView,
} from "@usine/orchestrator/operator";
import { durationLabel, poolLabel, tokensLabel, usdLabel } from "../../operator-copy.ts";

const DAY = 86_400_000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export const windowLabels = {
  "7d": "7 days",
  "30d": "30 days",
  all: "All",
} as const satisfies Record<StatisticsWindow, string>;

/** Returns the end of an empty-state fragment, such as `in the last 7 days`, or `yet` for all. */
export const windowPhrase = (window: StatisticsWindow): string =>
  window === "all" ? "yet" : `in the last ${windowLabels[window]}`;

/** Returns a UTC day such as `2026-10-22` as `22 Oct`. */
export const utcDayLabel = (day: string): string => {
  const date = new Date(`${day}T00:00:00.000Z`);
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]}`;
};

/** Returns a period start as `22 Oct`, or `Week of 19 Oct` for weekly periods. */
export const periodLabel = (start: string, bucket: StatisticsBucket): string =>
  bucket === "day" ? utcDayLabel(start) : `Week of ${utcDayLabel(start)}`;

/** Returns the window's start, for example `From 19 Oct, by UTC day`. */
export const windowNote = (from: string, bucket: StatisticsBucket): string =>
  `From ${utcDayLabel(from.slice(0, 10))}, by UTC ${bucket}`;

/**
 * Returns a duration as `durationLabel` does, with `under 1s` below a second and days and hours
 * from two days up: `3 d 4 h`.
 */
export const spanLabel = (milliseconds: number): string => {
  if (milliseconds < 1000) return "under 1s";
  if (milliseconds < 2 * DAY) return durationLabel(milliseconds);
  const hours = Math.round(milliseconds / 3_600_000);
  return hours % 24 === 0 ? `${hours / 24} d` : `${Math.floor(hours / 24)} d ${hours % 24} h`;
};

export const percentLabel = (part: number, whole: number): string =>
  whole === 0 ? "0%" : `${Math.round((part / whole) * 100)}%`;

export const outcomeTotal = ({ succeeded, failed, canceled }: OutcomeCountsView): number =>
  succeeded + failed + canceled;

export const countLabel = (count: number, one: string, many: string): string =>
  `${count.toLocaleString("en")} ${count === 1 ? one : many}`;

/** Returns text such as `81% succeeded, 12% failed, 7% canceled`. */
export const outcomeReading = (outcomes: OutcomeCountsView): string => {
  const total = outcomeTotal(outcomes);
  return `${percentLabel(outcomes.succeeded, total)} succeeded, ${percentLabel(outcomes.failed, total)} failed, ${percentLabel(outcomes.canceled, total)} canceled`;
};

/** Returns the median duration for a figure value, such as `18 min`. */
export const medianLabel = (summary: DurationSummaryView): string =>
  spanLabel(summary.medianMillis);

/** Returns text such as `p90 1 h 4 min, mean 26 min`. */
export const spreadLabel = (summary: DurationSummaryView): string =>
  `p90 ${spanLabel(summary.p90Millis)}, mean ${spanLabel(summary.meanMillis)}`;

/** Returns text such as `31 runs on 22 Oct, the busiest day`. */
export const throughputReading = (
  periods: ReadonlyArray<ThroughputPeriodView>,
  bucket: StatisticsBucket,
): string => {
  const busiest = periods.reduce<{ readonly start: string; readonly runs: number } | null>(
    (most, period) => {
      const runs = outcomeTotal(period);
      return most === null || runs > most.runs ? { start: period.start, runs } : most;
    },
    null,
  );
  if (busiest === null) return "No closed runs";
  return `${countLabel(busiest.runs, "run", "runs")} ${bucket === "day" ? "on" : "in the week of"} ${utcDayLabel(busiest.start)}, the busiest ${bucket}`;
};

/** Returns the cost figure: the mean dollars per priced run, or `No price`. */
export const costValue = (usage: UsageSummaryView): string =>
  usage.cost === null ? "No price" : usdLabel(usage.cost.meanUsd);

/**
 * Returns text such as `Estimate, 31 of 142 runs priced`, or why no run has a price. ChatGPT plan
 * usage, which has no dollar rate, is named when present.
 */
export const costDetail = (usage: UsageSummaryView, unit: "run" | "attempt"): string => {
  const chatgpt = usage.pools.some(({ pool }) => pool === "chatgptPlan")
    ? "; ChatGPT plan has no dollar rate"
    : "";
  if (usage.cost === null)
    return usage.measured === 0
      ? `No ${unit}s with an attempt`
      : `No ${unit} has a price for every session${chatgpt}`;
  const priced = `${usage.cost.priced.toLocaleString("en")} of ${countLabel(usage.measured, unit, `${unit}s`)} priced`;
  return `${usage.cost.estimate ? `Estimate, ${priced}` : priced}${chatgpt}`;
};

/** Returns text such as `8.2M in all: API keys 1.2M, Claude plan 7M`. */
export const tokensDetail = (usage: UsageSummaryView): string =>
  usage.pools.length === 0
    ? "No token reports"
    : `${tokensLabel(usage.tokens)} in all: ${usage.pools
        .map(({ pool, tokens }) => `${poolLabel(pool)} ${tokensLabel(tokens)}`)
        .join(", ")}`;

/** Returns text such as `9 of 14 merged pull requests with no loop run twice on an item`. */
export const firstPassReading = ({ merged, firstPass }: FirstPassView): string =>
  `${firstPass.toLocaleString("en")} of ${countLabel(merged, "merged pull request", "merged pull requests")} with no loop run twice on an item`;

/** Returns text such as `92% of runs in one attempt, at most 4`. */
export const attemptsReading = (counts: ReadonlyArray<AttemptCountView>): string => {
  const total = counts.reduce((sum, { runs }) => sum + runs, 0);
  const once = counts.find(({ attempts }) => attempts === 1)?.runs ?? 0;
  const most = counts.at(-1)?.attempts ?? 1;
  return most === 1
    ? "Every run in one attempt"
    : `${percentLabel(once, total)} of runs in one attempt, at most ${most}`;
};

export const attemptCountLabel = (attempts: number): string =>
  countLabel(attempts, "attempt", "attempts");

/** Returns text such as `Longest median wait 4s, on usine-worker-1`. */
export const queueWaitReading = (waits: ReadonlyArray<WorkerQueueWaitView>): string => {
  const longest = waits.reduce<WorkerQueueWaitView | null>(
    (most, wait) =>
      most === null || wait.wait.medianMillis > most.wait.medianMillis ? wait : most,
    null,
  );
  return longest === null
    ? "No attempts started"
    : `Longest median wait ${spanLabel(longest.wait.medianMillis)}, on ${longest.worker}`;
};

/** Returns text such as `Slots held 38% of the time on usine-worker-1`. */
export const utilizationReading = (workers: ReadonlyArray<WorkerUtilizationView>): string => {
  const busiest = workers.reduce<WorkerUtilizationView | null>(
    (most, worker) => (most === null || worker.share > most.share ? worker : most),
    null,
  );
  return busiest === null
    ? "No workers in usine.yaml"
    : `Slots held ${percentLabel(busiest.share, 1)} of the time on ${busiest.worker}`;
};

/** Returns text such as `12 approvals and 4 failures to answer`. */
export const needsAttentionReading = ({ approvals, failures }: NeedsAttentionView): string =>
  `${countLabel(approvals, "approval", "approvals")} and ${countLabel(failures, "failure", "failures")} to answer`;
