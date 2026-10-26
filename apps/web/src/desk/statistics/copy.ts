import type {
  AttemptCountView,
  OutcomeCountsView,
  StatisticsBucket,
  StatisticsWindow,
  UntimedTasksView,
} from "@usine/orchestrator/operator";
import { durationLabel } from "../../operator-copy.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
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

/** Returns an instant as its UTC day, such as `22 Oct`. */
export const instantDayLabel = (epochMillis: number): string =>
  utcDayLabel(new Date(epochMillis).toISOString().slice(0, 10));

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
  const hours = Math.round(milliseconds / HOUR);
  return hours % 24 === 0 ? `${hours / 24} d` : `${Math.floor(hours / 24)} d ${hours % 24} h`;
};

/**
 * Returns a duration rounded for speech: to the minute under 10 minutes, to 5 minutes under an
 * hour, to 10 minutes under 10 hours, then to the hour, for example `about 25 min`.
 */
export const aboutLabel = (milliseconds: number): string => {
  const minutes = milliseconds / MINUTE;
  const step = minutes < 10 ? 1 : minutes < 60 ? 5 : minutes < 600 ? 10 : 60;
  return `about ${spanLabel(Math.max(1, Math.round(minutes / step)) * step * MINUTE)}`;
};

export const percentLabel = (part: number, whole: number): string =>
  whole === 0 ? "0%" : `${Math.round((part / whole) * 100)}%`;

export const shareLabel = (share: number): string =>
  share > 0 && share < 0.005 ? "under 1%" : `${Math.round(share * 100)}%`;

export const outcomeTotal = ({ succeeded, failed, canceled }: OutcomeCountsView): number =>
  succeeded + failed + canceled;

export const countLabel = (count: number, one: string, many: string): string =>
  `${count.toLocaleString("en")} ${count === 1 ? one : many}`;

/** Returns a count per task to one decimal, such as `1.4`. */
export const perTaskLabel = (count: number, tasks: number): string =>
  tasks === 0 ? "0" : (count / tasks).toLocaleString("en", { maximumFractionDigits: 1 });

export const noTasksLine = (window: StatisticsWindow): string =>
  `No tasks done ${windowPhrase(window)}`;

/** Returns text such as `19 tasks before 19 Oct lack timing and are left out`. */
export const untimedLine = ({ tasks, before }: UntimedTasksView): string =>
  tasks === 1
    ? `1 task before ${utcDayLabel(before)} lacks timing and is left out`
    : `${tasks.toLocaleString("en")} tasks before ${utcDayLabel(before)} lack timing and are left out`;

/** Returns text such as `3 tasks lack token reports and are left out of tokens`. */
export const unmeteredLine = (tasks: number): string =>
  tasks === 1
    ? "1 task lacks token reports and is left out of tokens"
    : `${tasks.toLocaleString("en")} tasks lack token reports and are left out of tokens`;

export const attemptCountLabel = (attempts: number): string =>
  countLabel(attempts, "attempt", "attempts");

/** Returns the share of closed runs that took one attempt, such as `92%`. */
export const oneAttemptShare = (counts: ReadonlyArray<AttemptCountView>): string =>
  percentLabel(
    counts.find(({ attempts }) => attempts === 1)?.runs ?? 0,
    counts.reduce((sum, { runs }) => sum + runs, 0),
  );
