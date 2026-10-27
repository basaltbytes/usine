import { type ChartConfig } from "~/components/ui/chart";
import { spanLabel } from "~/features/overview/lib/statistics/strings";

export const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** The duration ticks of the log axis; the axis spans the rungs around the data. */
const LADDER: ReadonlyArray<readonly [number, string]> = [
  [MINUTE, "1 min"],
  [15 * MINUTE, "15 min"],
  [HOUR, "1 h"],
  [4 * HOUR, "4 h"],
  [DAY, "1 d"],
  [7 * DAY, "1 w"],
  [28 * DAY, "4 w"],
];
/** The factor the log axis extends past its outer rungs, so dots on a rung stay whole. */
const EDGE = 1.25;

export const chartConfig = {
  task: { label: "task", color: "var(--chart-1)" },
  tasks: { label: "tasks", color: "var(--chart-1)" },
  median: { label: "median", color: "var(--muted-foreground)" },
} satisfies ChartConfig;

/** Returns the log axis domain and ticks: the ladder rungs that bracket `durations`. */
export const durationAxis = (durations: ReadonlyArray<number>) => {
  const low = Math.min(...durations);
  const high = Math.max(...durations);
  const below = LADDER.filter(([rung]) => rung <= low).at(-1) ?? LADDER[0];
  const above = LADDER.find(([rung]) => rung >= high) ?? LADDER.at(-1);
  const floor = below?.[0] ?? MINUTE;
  const ceiling = Math.max(above?.[0] ?? high, high);
  const domain: [number, number] = [floor / EDGE, ceiling * EDGE];
  return {
    domain,
    ticks: LADDER.filter(([rung]) => rung >= floor && rung <= ceiling).map(([rung]) => rung),
  };
};

export const ladderLabel = (rung: number): string =>
  LADDER.find(([value]) => value === rung)?.[1] ?? spanLabel(rung);

export const tooltipClass =
  "grid min-w-24 gap-0.5 rounded-md bg-popover px-2.5 py-1.5 text-xs shadow-raised tabular-nums";
