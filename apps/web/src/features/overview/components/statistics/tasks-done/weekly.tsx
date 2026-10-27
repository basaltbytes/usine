import type { StatisticsView } from "@usine/orchestrator/operator";
import { Bar, BarChart, CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts";
import { ChartContainer, ChartTooltip } from "~/components/ui/chart";
import {
  MINUTE,
  chartConfig,
  durationAxis,
  ladderLabel,
  tooltipClass,
} from "~/features/overview/lib/statistics/chart";
import { periodLabel, spanLabel, utcDayLabel } from "~/features/overview/lib/statistics/strings";

type WeeklyTasksProps = { readonly statistics: StatisticsView };

/** Tasks done per week as columns over the median duration per week, for long windows. */
export const WeeklyTasks = ({ statistics }: WeeklyTasksProps) => {
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
