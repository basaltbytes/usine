import type { StatisticsView, TaskPeriodView } from "@usine/orchestrator/operator";
import type { ReactNode } from "react";
import { percentLabel, periodLabel, perTaskLabel } from "~/features/overview/strings";

/** The most points a sparkline shows; longer windows merge neighbouring periods. */
const SPARK_POINTS = 8;
const WIDTH = 96;
const HEIGHT = 28;
const INSET = 4;

interface SparkPoint {
  readonly label: string;
  /** The value, or null for a group with no task done. */
  readonly value: number | null;
}

/** Merges `periods` into at most eight groups of neighbours and measures each with `measure`. */
const sparkPoints = (
  statistics: StatisticsView,
  measure: (tasks: number, group: ReadonlyArray<TaskPeriodView>) => number,
): ReadonlyArray<SparkPoint> => {
  const size = Math.ceil(statistics.periods.length / SPARK_POINTS);
  const groups: Array<ReadonlyArray<TaskPeriodView>> = [];
  for (let start = 0; start < statistics.periods.length; start += size)
    groups.push(statistics.periods.slice(start, start + size));
  return groups.map((group) => {
    const tasks = group.reduce((sum, { tasks }) => sum + tasks, 0);
    const first = group[0];
    return {
      label: first === undefined ? "" : periodLabel(first.start, statistics.bucket),
      value: tasks === 0 ? null : measure(tasks, group),
    };
  });
};

type SparklineProps = {
  readonly label: string;
  readonly points: ReadonlyArray<SparkPoint>;
  readonly ceiling: number;
  readonly format: (value: number) => string;
};

/** A line over the groups with a task done, its last point marked in sapphire. */
const Sparkline = ({ label, points, ceiling, format }: SparklineProps) => {
  const step = points.length < 2 ? 0 : (WIDTH - 2 * INSET) / (points.length - 1);
  const placed = points.flatMap(({ value }, index) =>
    value === null
      ? []
      : [
          {
            x: INSET + index * step,
            y: HEIGHT - INSET - (ceiling === 0 ? 0 : (value / ceiling) * (HEIGHT - 2 * INSET)),
          },
        ],
  );
  const last = placed.at(-1);
  return (
    <svg
      role="img"
      aria-label={`${label}: ${points
        .map(({ label: period, value }) => `${period} ${value === null ? "none" : format(value)}`)
        .join(", ")}`}
      width={WIDTH}
      height={HEIGHT}
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      className="shrink-0 overflow-visible"
    >
      {placed.length > 1 && (
        <polyline
          points={placed.map(({ x, y }) => `${x},${y}`).join(" ")}
          fill="none"
          stroke="var(--muted-foreground)"
          strokeWidth={1.5}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )}
      {last !== undefined && (
        <circle
          cx={last.x}
          cy={last.y}
          r={3}
          fill="var(--chart-1)"
          stroke="var(--background)"
          strokeWidth={2}
        />
      )}
    </svg>
  );
};

type FigureProps = {
  readonly value: string;
  readonly unit: string;
  readonly children: ReactNode;
};

const Figure = ({ value, unit, children }: FigureProps) => (
  <div className="contents">
    <p className="flex min-w-0 items-baseline gap-1.5">
      <span className="text-xl font-semibold">{value}</span>{" "}
      <span className="text-sm text-muted-foreground">{unit}</span>
    </p>
    {children}
  </div>
);

type FirstTimeRightProps = { readonly statistics: StatisticsView };

/** The share of tasks done with no second round, and the operator's actions per task. */
export const FirstTimeRight = ({ statistics }: FirstTimeRightProps) => {
  const tasks = statistics.tasks.length;
  const shares = sparkPoints(
    statistics,
    (count, group) => group.reduce((sum, { firstTimeRight }) => sum + firstTimeRight, 0) / count,
  );
  const actions = sparkPoints(
    statistics,
    (count, group) => group.reduce((sum, { operatorActions }) => sum + operatorActions, 0) / count,
  );
  return (
    <div className="grid grid-cols-[auto_auto] items-center justify-start gap-x-8 gap-y-4">
      <Figure value={percentLabel(statistics.firstTimeRight, tasks)} unit="of tasks">
        <Sparkline
          label="First time right per period"
          points={shares}
          ceiling={1}
          format={(share) => percentLabel(share, 1)}
        />
      </Figure>
      <Figure
        value={perTaskLabel(statistics.operatorActions, tasks)}
        unit="operator actions per task"
      >
        <Sparkline
          label="Operator actions per task per period"
          points={actions}
          ceiling={Math.max(1, ...actions.flatMap(({ value }) => (value === null ? [] : [value])))}
          format={(value) => perTaskLabel(value, 1)}
        />
      </Figure>
    </div>
  );
};
