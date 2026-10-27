import { useNavigate } from "@tanstack/react-router";
import type { StatisticsView, TaskDoneView } from "@usine/orchestrator/operator";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  Scatter,
  ScatterChart,
  XAxis,
  YAxis,
  ZAxis,
} from "recharts";
import { type ChartConfig, ChartContainer, ChartTooltip } from "@/components/ui/chart";
import { projectParams } from "../../overview.ts";
import { ChartTable } from "./charts.tsx";
import { instantDayLabel, periodLabel, spanLabel, utcDayLabel } from "./copy.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

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

const chartConfig = {
  task: { label: "task", color: "var(--chart-1)" },
  tasks: { label: "tasks", color: "var(--chart-1)" },
  median: { label: "median", color: "var(--muted-foreground)" },
} satisfies ChartConfig;

/** Returns the log axis domain and ticks: the ladder rungs that bracket `durations`. */
const durationAxis = (durations: ReadonlyArray<number>) => {
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

const ladderLabel = (rung: number): string =>
  LADDER.find(([value]) => value === rung)?.[1] ?? spanLabel(rung);

/** Returns a tick every day for a week or less, else every 7 days, from the window's start. */
const dayTicks = (from: number, to: number): ReadonlyArray<number> => {
  const days = Math.ceil((to - from) / DAY);
  const step = days <= 8 ? DAY : 7 * DAY;
  const ticks: Array<number> = [];
  for (let tick = from; tick < to; tick += step) ticks.push(tick);
  return ticks;
};

export const TasksDoneLegend = ({ points }: { readonly points: "dot" | "column" }) => (
  <ul className="flex items-center gap-4 text-xs text-muted-foreground">
    <li className="inline-flex items-center gap-1.5">
      <span
        aria-hidden="true"
        className={
          points === "dot" ? "size-2 rounded-full bg-chart-1" : "size-2 rounded-[2px] bg-chart-1"
        }
      />
      {points === "dot" ? "task" : "tasks"}
    </li>
    <li className="inline-flex items-center gap-1.5">
      <span aria-hidden="true" className="h-0.5 w-3 rounded-full bg-muted-foreground" />
      median
    </li>
  </ul>
);

interface TaskPoint {
  readonly x: number;
  readonly y: number;
  /** A constant that the dot and hit layers' z axes map to their symbol sizes. */
  readonly z: 1;
  readonly task: TaskDoneView;
}

/** The symbol areas, in square pixels, of an 8px dot and of its 24px hit area. */
const DOT_AREA = Math.PI * 4 ** 2;
const HIT_AREA = Math.PI * 12 ** 2;

const tooltipClass =
  "grid min-w-24 gap-0.5 rounded-md bg-popover px-2.5 py-1.5 text-xs shadow-raised tabular-nums";

const taskName = (task: TaskDoneView, repositories: number) =>
  repositories > 1 ? `${task.repository} #${task.number}` : `#${task.number}`;

/** One dot per task done: merge day across, time in usine up a log axis. */
const TaskScatter = ({ statistics }: { readonly statistics: StatisticsView }) => {
  const navigate = useNavigate();
  const from = Date.parse(statistics.from);
  const to = Date.parse(statistics.to);
  const end = to - (to % DAY) + DAY;
  const points: ReadonlyArray<TaskPoint> = statistics.tasks.map((task) => ({
    x: Date.parse(task.mergedAt),
    y: Math.max(MINUTE, task.durationMillis),
    z: 1,
    task,
  }));
  const axis = durationAxis(points.map(({ y }) => y));
  const repositories = new Set(statistics.tasks.map(({ repository }) => repository)).size;
  return (
    <ChartContainer config={chartConfig} className="aspect-auto h-60 w-full">
      <ScatterChart margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
        <CartesianGrid vertical={false} />
        <XAxis
          type="number"
          dataKey="x"
          scale="time"
          domain={[from, end]}
          ticks={[...dayTicks(from, end)]}
          tickFormatter={(tick: number) => instantDayLabel(tick)}
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          minTickGap={16}
        />
        <YAxis
          type="number"
          dataKey="y"
          scale="log"
          domain={axis.domain}
          ticks={axis.ticks}
          tickFormatter={ladderLabel}
          allowDataOverflow
          tickLine={false}
          axisLine={false}
          width={48}
        />
        <ReferenceLine
          y={Math.max(MINUTE, statistics.medianMillis ?? MINUTE)}
          stroke="var(--color-median)"
          strokeWidth={2}
        />
        <ChartTooltip
          cursor={false}
          content={({ active, payload }) => {
            const point: TaskPoint | undefined = payload?.[0]?.payload;
            return active === true && point !== undefined ? (
              <div className={tooltipClass}>
                <span className="font-medium text-foreground">
                  {spanLabel(point.task.durationMillis)}
                </span>
                <span className="text-muted-foreground">{taskName(point.task, repositories)}</span>
              </div>
            ) : null;
          }}
        />
        <ZAxis zAxisId="dot" dataKey="z" range={[DOT_AREA, DOT_AREA]} />
        <ZAxis zAxisId="hit" dataKey="z" range={[HIT_AREA, HIT_AREA]} />
        <Scatter
          zAxisId="dot"
          data={[...points]}
          fill="var(--color-task)"
          stroke="var(--background)"
          strokeWidth={2}
          isAnimationActive={false}
        />
        <Scatter
          zAxisId="hit"
          data={[...points]}
          fill="transparent"
          className="cursor-pointer"
          isAnimationActive={false}
          onClick={(entry: { payload?: TaskPoint }) => {
            const task = entry.payload?.task;
            if (task !== undefined)
              void navigate({
                to: "/projects/$owner/$name/tasks/$number",
                params: { ...projectParams(task.repository), number: String(task.number) },
              });
          }}
        />
      </ScatterChart>
    </ChartContainer>
  );
};

/** Tasks done per week as columns over the median duration per week, for long windows. */
const WeeklyTasks = ({ statistics }: { readonly statistics: StatisticsView }) => {
  const data = statistics.periods.map(({ start, tasks, medianMillis }) => ({
    start,
    tasks,
    median: medianMillis === null ? null : Math.max(MINUTE, medianMillis),
  }));
  const axis = durationAxis(data.flatMap(({ median }) => (median === null ? [] : [median])));
  const xAxis = (
    <XAxis
      dataKey="start"
      tickLine={false}
      axisLine={false}
      tickMargin={8}
      minTickGap={24}
      tickFormatter={(start: string) => utcDayLabel(start)}
    />
  );
  const tooltip = (
    <ChartTooltip
      cursor={{ fill: "var(--muted)", fillOpacity: 0.5 }}
      content={({ active, payload }) => {
        const period: (typeof data)[number] | undefined = payload?.[0]?.payload;
        return active === true && period !== undefined ? (
          <div className={tooltipClass}>
            <span className="font-medium text-foreground">
              {period.tasks} {period.tasks === 1 ? "task" : "tasks"}
              {period.median === null ? "" : `, median ${spanLabel(period.median)}`}
            </span>
            <span className="text-muted-foreground">{periodLabel(period.start, "week")}</span>
          </div>
        ) : null;
      }}
    />
  );
  return (
    <div className="flex flex-col gap-1">
      <ChartContainer config={chartConfig} className="aspect-auto h-28 w-full">
        <BarChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid vertical={false} />
          {xAxis}
          <YAxis allowDecimals={false} tickLine={false} axisLine={false} width={48} />
          {tooltip}
          <Bar
            dataKey="tasks"
            fill="var(--color-tasks)"
            radius={[4, 4, 0, 0]}
            maxBarSize={24}
            isAnimationActive={false}
          />
        </BarChart>
      </ChartContainer>
      <ChartContainer config={chartConfig} className="aspect-auto h-36 w-full">
        <LineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid vertical={false} />
          {xAxis}
          <YAxis
            scale="log"
            domain={axis.domain}
            ticks={axis.ticks}
            tickFormatter={ladderLabel}
            allowDataOverflow
            tickLine={false}
            axisLine={false}
            width={48}
          />
          {tooltip}
          <Line
            dataKey="median"
            stroke="var(--color-median)"
            strokeWidth={2}
            dot={{ r: 4, fill: "var(--color-median)", stroke: "var(--background)", strokeWidth: 2 }}
            connectNulls
            isAnimationActive={false}
          />
        </LineChart>
      </ChartContainer>
    </div>
  );
};

/** The tasks done chart: dots per task, or weekly columns when the window counts per week. */
export const TasksDoneChart = ({ statistics }: { readonly statistics: StatisticsView }) => (
  <div className="flex flex-col gap-2">
    {statistics.bucket === "day" ? (
      <TaskScatter statistics={statistics} />
    ) : (
      <WeeklyTasks statistics={statistics} />
    )}
    <ChartTable
      caption="Tasks done, time in usine"
      head={["Task", "Merged", "Duration"]}
      rows={statistics.tasks.map((task) => [
        `${task.repository} #${task.number}`,
        instantDayLabel(Date.parse(task.mergedAt)),
        spanLabel(task.durationMillis),
      ])}
    />
  </div>
);
