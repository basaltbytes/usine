import { useNavigate } from "@tanstack/react-router";
import type { StatisticsView, TaskDoneView } from "@usine/orchestrator/operator";
import { CartesianGrid, ReferenceLine, Scatter, ScatterChart, XAxis, YAxis, ZAxis } from "recharts";
import { ChartContainer, ChartTooltip } from "~/components/ui/chart";
import {
  DAY,
  MINUTE,
  chartConfig,
  durationAxis,
  ladderLabel,
  tooltipClass,
} from "~/features/overview/lib/statistics/chart";
import { instantDayLabel, spanLabel } from "~/features/overview/strings";
import { projectParams } from "~/lib/overview";

/** Returns a tick every day for a week or less, else every 7 days, from the window's start. */
const dayTicks = (from: number, to: number): ReadonlyArray<number> => {
  const days = Math.ceil((to - from) / DAY);
  const step = days <= 8 ? DAY : 7 * DAY;
  const ticks: Array<number> = [];
  for (let tick = from; tick < to; tick += step) ticks.push(tick);
  return ticks;
};

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

const taskName = (task: TaskDoneView, repositories: number) =>
  repositories > 1 ? `${task.repository} #${task.number}` : `#${task.number}`;

type TaskScatterProps = { readonly statistics: StatisticsView };

/** One dot per task done: merge day across, time in usine up a log axis. */
export const TaskScatter = ({ statistics }: TaskScatterProps) => {
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
                to: "/projects/$project/$name/tasks/$number",
                params: { ...projectParams(task.repository), number: String(task.number) },
              });
          }}
        />
      </ScatterChart>
    </ChartContainer>
  );
};
