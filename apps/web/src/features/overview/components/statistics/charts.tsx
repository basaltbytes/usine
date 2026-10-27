import type {
  AttemptCountView,
  NeedsAttentionPeriodView,
  StatisticsBucket,
  ThroughputPeriodView,
  WorkerUtilizationView,
} from "@usine/orchestrator/operator";
import type { ReactNode } from "react";
import { Bar, BarChart, CartesianGrid, LabelList, XAxis, YAxis } from "recharts";
import {
  type ChartConfig,
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
} from "~/components/ui/chart";
import {
  attemptCountLabel,
  countLabel,
  percentLabel,
  periodLabel,
  spanLabel,
  utcDayLabel,
} from "~/features/overview/lib/statistics/strings";

const OUTCOMES = ["succeeded", "failed", "canceled"] as const;

/** The run state tones of ADR 0015, so an outcome has the same colour as its state mark. */
const outcomeConfig = {
  succeeded: { label: "Succeeded", color: "var(--run-succeeded)" },
  failed: { label: "Failed", color: "var(--run-failed)" },
  canceled: { label: "Canceled", color: "var(--run-canceled)" },
} satisfies ChartConfig;

const tooltipClass = "border-0 bg-popover shadow-raised";

/** A titled block of the Details panel: a 13px title and its chart. */
export const StatisticsBlock = ({
  title,
  actions,
  children,
}: {
  readonly title: string;
  /** Controls at the end of the header. */
  readonly actions?: ReactNode;
  readonly children?: ReactNode;
}) => (
  <section className="flex min-w-0 flex-col gap-2.5">
    <header className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
      <h4 className="text-sm font-medium">{title}</h4>
      {actions}
    </header>
    {children}
  </section>
);

/** The values of a chart as a table for screen readers. */
export const ChartTable = ({
  caption,
  head,
  rows,
}: {
  readonly caption: string;
  readonly head: ReadonlyArray<string>;
  readonly rows: ReadonlyArray<readonly [string, ...ReadonlyArray<string>]>;
}) => (
  <table className="sr-only">
    <caption>{caption}</caption>
    <thead>
      <tr>
        {head.map((cell) => (
          <th key={cell} scope="col">
            {cell}
          </th>
        ))}
      </tr>
    </thead>
    <tbody>
      {rows.map(([name, ...cells]) => (
        <tr key={name}>
          <th scope="row">{name}</th>
          {cells.map((cell, index) => (
            <td key={head[index + 1] ?? index}>{cell}</td>
          ))}
        </tr>
      ))}
    </tbody>
  </table>
);

/** Closed runs per period as columns stacked by outcome. */
export const ThroughputChart = ({
  periods,
  bucket,
}: {
  readonly periods: ReadonlyArray<ThroughputPeriodView>;
  readonly bucket: StatisticsBucket;
}) => (
  <>
    <ChartContainer config={outcomeConfig} className="aspect-auto h-44 w-full">
      <BarChart
        data={[...periods]}
        margin={{ top: 4, right: 0, bottom: 0, left: 0 }}
        barCategoryGap="16%"
      >
        <CartesianGrid vertical={false} />
        <XAxis
          dataKey="start"
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          minTickGap={24}
          tickFormatter={(start: string) => utcDayLabel(start)}
        />
        <YAxis allowDecimals={false} tickLine={false} axisLine={false} width={28} />
        <ChartTooltip
          cursor={{ fill: "var(--muted)", fillOpacity: 0.5 }}
          content={
            <ChartTooltipContent
              className={tooltipClass}
              labelFormatter={(label) => periodLabel(String(label), bucket)}
            />
          }
        />
        <ChartLegend
          content={<ChartLegendContent />}
          itemSorter={(item) => OUTCOMES.findIndex((outcome) => outcome === item.dataKey)}
        />
        {OUTCOMES.map((outcome) => (
          <Bar
            key={outcome}
            dataKey={outcome}
            stackId="outcome"
            fill={`var(--color-${outcome})`}
            stroke="var(--background)"
            strokeWidth={2}
            maxBarSize={24}
            isAnimationActive={false}
          />
        ))}
      </BarChart>
    </ChartContainer>
    <ChartTable
      caption="Closed runs per period by outcome"
      head={["Period", "Succeeded", "Failed", "Canceled"]}
      rows={periods.map(({ start, succeeded, failed, canceled }) => [
        periodLabel(start, bucket),
        String(succeeded),
        String(failed),
        String(canceled),
      ])}
    />
  </>
);

const attemptsConfig = {
  runs: { label: "Runs", color: "var(--chart-1)" },
} satisfies ChartConfig;

/** Closed runs per number of attempts, as horizontal bars with their counts at the tips. */
export const AttemptsChart = ({ counts }: { readonly counts: ReadonlyArray<AttemptCountView> }) => {
  const data = counts.map(({ attempts, runs }) => ({ label: attemptCountLabel(attempts), runs }));
  return (
    <>
      <ChartContainer
        config={attemptsConfig}
        className="aspect-auto w-full"
        style={{ height: Math.max(2, data.length) * 28 + 8 }}
      >
        <BarChart data={data} layout="vertical" margin={{ top: 4, right: 40, bottom: 4, left: 0 }}>
          <XAxis type="number" hide allowDecimals={false} />
          <YAxis type="category" dataKey="label" tickLine={false} axisLine={false} width={76} />
          <ChartTooltip
            cursor={{ fill: "var(--muted)", fillOpacity: 0.5 }}
            content={<ChartTooltipContent className={tooltipClass} hideIndicator />}
          />
          <Bar
            dataKey="runs"
            fill="var(--color-runs)"
            radius={[0, 4, 4, 0]}
            maxBarSize={18}
            isAnimationActive={false}
          >
            <LabelList
              dataKey="runs"
              position="right"
              offset={8}
              className="fill-foreground tabular-nums"
            />
          </Bar>
        </BarChart>
      </ChartContainer>
      <ChartTable
        caption="Closed runs per number of attempts"
        head={["Attempts", "Runs"]}
        rows={data.map(({ label, runs }) => [label, String(runs)])}
      />
    </>
  );
};

const needsAttentionConfig = {
  entries: { label: "Entries", color: "var(--needs-you)" },
} satisfies ChartConfig;

/** Needs attention entries per period as one series in the Needs attention tone. */
export const NeedsAttentionChart = ({
  periods,
  bucket,
}: {
  readonly periods: ReadonlyArray<NeedsAttentionPeriodView>;
  readonly bucket: StatisticsBucket;
}) => {
  const data = periods.map(({ start, approvals, failures }) => ({
    start,
    approvals,
    failures,
    entries: approvals + failures,
  }));
  const kinds = new Map(data.map((period) => [period.start, period]));
  return (
    <>
      <ChartContainer config={needsAttentionConfig} className="aspect-auto h-32 w-full">
        <BarChart data={data} margin={{ top: 4, right: 0, bottom: 0, left: 0 }}>
          <CartesianGrid vertical={false} />
          <XAxis
            dataKey="start"
            tickLine={false}
            axisLine={false}
            tickMargin={8}
            minTickGap={24}
            tickFormatter={(start: string) => utcDayLabel(start)}
          />
          <YAxis allowDecimals={false} tickLine={false} axisLine={false} width={28} />
          <ChartTooltip
            cursor={{ fill: "var(--muted)", fillOpacity: 0.5 }}
            content={
              <ChartTooltipContent
                className={tooltipClass}
                hideIndicator
                labelFormatter={(label) => {
                  const start = String(label);
                  const period = kinds.get(start);
                  return period === undefined
                    ? periodLabel(start, bucket)
                    : `${periodLabel(start, bucket)}: ${countLabel(period.approvals, "approval", "approvals")}, ${countLabel(period.failures, "failure", "failures")}`;
                }}
              />
            }
          />
          <Bar
            dataKey="entries"
            fill="var(--color-entries)"
            radius={[4, 4, 0, 0]}
            maxBarSize={24}
            isAnimationActive={false}
          />
        </BarChart>
      </ChartContainer>
      <ChartTable
        caption="Needs attention entries per period"
        head={["Period", "Approvals", "Failures"]}
        rows={data.map(({ start, approvals, failures }) => [
          periodLabel(start, bucket),
          String(approvals),
          String(failures),
        ])}
      />
    </>
  );
};

/** One meter per worker: the share of the window its slots held attempts. */
export const UtilizationMeters = ({
  workers,
}: {
  readonly workers: ReadonlyArray<WorkerUtilizationView>;
}) => (
  <ul className="flex flex-col gap-3">
    {workers.map(({ worker, slots, occupiedMillis, share }) => (
      <li key={worker} className="flex flex-col gap-1.5">
        <div className="flex items-baseline justify-between gap-3 text-xs">
          <span className="truncate font-mono text-foreground">{worker}</span>
          <span className="text-sm font-medium tabular-nums">{percentLabel(share, 1)}</span>
        </div>
        <div
          role="meter"
          aria-label={`${worker} slot use`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(share * 100)}
          className="h-1.5 overflow-hidden rounded-full bg-chart-1/15"
        >
          <div className="h-full rounded-full bg-chart-1" style={{ width: `${share * 100}%` }} />
        </div>
        <span className="text-xs text-muted-foreground tabular-nums">
          {countLabel(slots, "slot", "slots")}, {spanLabel(occupiedMillis)} held
        </span>
      </li>
    ))}
  </ul>
);
