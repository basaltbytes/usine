import type {
  AttemptCountView,
  NeedsAttentionPeriodView,
  OutcomeCountsView,
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
} from "@/components/ui/chart";
import { cn } from "@/lib/utils";
import {
  attemptCountLabel,
  countLabel,
  outcomeTotal,
  percentLabel,
  periodLabel,
  spanLabel,
  utcDayLabel,
} from "./copy.ts";

export const OUTCOMES = ["succeeded", "failed", "canceled"] as const;

/** The run state tones of ADR 0015, so an outcome has the same colour as its state mark. */
export const outcomeConfig = {
  succeeded: { label: "Succeeded", color: "var(--run-succeeded)" },
  failed: { label: "Failed", color: "var(--run-failed)" },
  canceled: { label: "Canceled", color: "var(--run-canceled)" },
} satisfies ChartConfig;

const outcomeFill = {
  succeeded: "bg-run-succeeded",
  failed: "bg-run-failed",
  canceled: "bg-run-canceled",
} as const;

const tooltipClass = "border-0 bg-popover shadow-raised";

/** A titled block of the Statistics section: a 13px title, a one-line reading, and its chart. */
export const StatisticsBlock = ({
  title,
  reading,
  actions,
  children,
}: {
  readonly title: string;
  readonly reading: string;
  /** Controls at the end of the header. */
  readonly actions?: ReactNode;
  readonly children?: ReactNode;
}) => (
  <section className="flex min-w-0 flex-col gap-3">
    <header className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
      <div className="flex min-w-0 flex-col gap-0.5">
        <h3 className="text-sm font-medium">{title}</h3>
        <p className="text-xs text-muted-foreground">{reading}</p>
      </div>
      {actions}
    </header>
    {children}
  </section>
);

/** The values of a chart as a table for screen readers. */
const ChartTable = ({
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

/** One horizontal bar split by outcome, 2px apart, with each outcome's share under it. */
export const OutcomeMix = ({ outcomes }: { readonly outcomes: OutcomeCountsView }) => {
  const total = outcomeTotal(outcomes);
  const present = OUTCOMES.filter((outcome) => outcomes[outcome] > 0);
  return (
    <div className="flex flex-col gap-2">
      <div aria-hidden="true" className="flex h-2 gap-0.5 overflow-hidden rounded-sm">
        {present.map((outcome) => (
          <div
            key={outcome}
            className={outcomeFill[outcome]}
            style={{ flexGrow: outcomes[outcome] }}
          />
        ))}
      </div>
      <ul className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground">
        {OUTCOMES.map((outcome) => (
          <li key={outcome} className="inline-flex items-center gap-1.5 tabular-nums">
            <span aria-hidden="true" className={cn("size-2 rounded-[2px]", outcomeFill[outcome])} />
            <span className="text-foreground">{outcomeConfig[outcome].label}</span>
            {outcomes[outcome].toLocaleString("en")} ({percentLabel(outcomes[outcome], total)})
          </li>
        ))}
      </ul>
    </div>
  );
};

/** Closed runs per period as columns stacked by outcome. */
export const ThroughputChart = ({
  periods,
  bucket,
}: {
  readonly periods: ReadonlyArray<ThroughputPeriodView>;
  readonly bucket: StatisticsBucket;
}) => (
  <>
    <ChartContainer config={outcomeConfig} className="aspect-auto h-56 w-full">
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
        style={{ height: Math.max(2, data.length) * 32 + 8 }}
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
            maxBarSize={20}
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
      <ChartContainer config={needsAttentionConfig} className="aspect-auto h-40 w-full">
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
