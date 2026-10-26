import type { RunSummary } from "@usine/engine/run-reader";
import { Array as EffectArray, DateTime, Option, Order } from "effect";
import type { StatisticsBucket, StatisticsWindow } from "./view.ts";

export const DAY = 86_400_000;
const WEEK = 7 * DAY;
/** The longest span, in days, that the time series still split into days. */
const DAILY_SPAN_DAYS = 62;
const WINDOW_DAYS = { "7d": 7, "30d": 30 } as const;

export const epoch = DateTime.toEpochMillis;

export const startOfUtcDay = (epochMillis: number): number => epochMillis - (epochMillis % DAY);

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

/** Returns the period length for a span: days up to 62 days, else weeks. */
export const spanBucket = (from: number, to: number): StatisticsBucket =>
  (startOfUtcDay(to) - from) / DAY + 1 <= DAILY_SPAN_DAYS ? "day" : "week";

export const utcDay = (epochMillis: number): string =>
  new Date(epochMillis).toISOString().slice(0, 10);

/** Returns the start of the period that holds `epochMillis`. Weeks start on Monday. */
export const periodStart = (bucket: StatisticsBucket, epochMillis: number): number => {
  const day = startOfUtcDay(epochMillis);
  return bucket === "day" ? day : day - ((new Date(day).getUTCDay() + 6) % 7) * DAY;
};

/** Returns the start of each period from `from` to `to`, oldest first. */
export const periodStarts = (
  bucket: StatisticsBucket,
  from: number,
  to: number,
): ReadonlyArray<number> => {
  const step = bucket === "day" ? DAY : WEEK;
  const starts: Array<number> = [];
  for (let start = periodStart(bucket, from); start <= to; start += step) starts.push(start);
  return starts;
};

export const sum = (values: ReadonlyArray<number>): number =>
  values.reduce((total, value) => total + value, 0);

/** Returns the median of `values`, the mean of the two middle values for an even count. */
export const median = (values: ReadonlyArray<number>): Option.Option<number> => {
  if (!EffectArray.isReadonlyArrayNonEmpty(values)) return Option.none();
  const sorted = EffectArray.sort(values, Order.Number);
  const middle = (sorted.length - 1) / 2;
  const lower = sorted[Math.floor(middle)] ?? sorted[0];
  const upper = sorted[Math.ceil(middle)] ?? lower;
  return Option.some((lower + upper) / 2);
};

/**
 * Whether the engine canceled the Run before any Attempt because a newer Event or an Item change
 * replaced it.
 */
export const replacedBeforeStart = ({ run, attempts }: RunSummary): boolean =>
  attempts.length === 0 &&
  run.state._tag === "Canceled" &&
  run.state.reason._tag !== "OperatorCanceled";
