import type {
  DurationSummaryView,
  OutcomeCountsView,
  StatisticsView,
  UsageSummaryView,
} from "@usine/orchestrator/operator";
import { useState } from "react";
import { Bar, BarChart, XAxis, YAxis } from "recharts";
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { brainLine, tokensLabel, usdLabel } from "../../operator-copy.ts";
import { OUTCOMES, outcomeConfig, StatisticsBlock } from "./charts.tsx";
import { countLabel, outcomeTotal, percentLabel, spanLabel, windowPhrase } from "./copy.ts";

type Dimension = "loop" | "agent" | "model";

const dimensions: ReadonlyArray<{ readonly value: Dimension; readonly label: string }> = [
  { value: "loop", label: "Loop" },
  { value: "agent", label: "Agent" },
  { value: "model", label: "Model" },
];

interface BreakdownRow {
  readonly name: string;
  readonly outcomes: OutcomeCountsView;
  readonly time: DurationSummaryView | null;
  readonly usage: UsageSummaryView;
}

const rowsOf = (statistics: StatisticsView, dimension: Dimension): ReadonlyArray<BreakdownRow> => {
  switch (dimension) {
    case "loop":
      return statistics.loops.map(({ loop, ...group }) => ({ name: loop, ...group }));
    case "agent":
      return statistics.agents.map(({ agent, ...group }) => ({ name: agent, ...group }));
    case "model":
      return statistics.brains.map(({ brain, ...group }) => ({ name: brainLine(brain), ...group }));
  }
};

const isDimension = (value: string | undefined): value is Dimension =>
  dimensions.some((dimension) => dimension.value === value);

/** Returns the reading for the largest group, such as `review-pr: 48 runs, the most`. */
const breakdownReading = (rows: ReadonlyArray<BreakdownRow>, unit: "run" | "attempt"): string => {
  const [top] = rows;
  return top === undefined
    ? `No ${unit}s`
    : `${top.name}: ${countLabel(outcomeTotal(top.outcomes), unit, `${unit}s`)}, the most`;
};

/** Closed runs per loop or agent, or ended attempts per model, by outcome, with time and usage. */
export const Breakdown = ({ statistics }: { readonly statistics: StatisticsView }) => {
  const [dimension, setDimension] = useState<Dimension>("loop");
  const rows = rowsOf(statistics, dimension);
  const unit = dimension === "model" ? "attempt" : "run";
  const data = rows.map(({ name, outcomes }) => ({ name, ...outcomes }));
  return (
    <StatisticsBlock
      title={dimension === "model" ? "Attempts per model" : `Runs per ${dimension}`}
      reading={breakdownReading(rows, unit)}
      actions={
        <ToggleGroup
          aria-label="Group by"
          variant="outline"
          size="sm"
          spacing={0}
          value={[dimension]}
          onValueChange={([value]) => {
            if (isDimension(value)) setDimension(value);
          }}
        >
          {dimensions.map(({ value, label }) => (
            <ToggleGroupItem key={value} value={value}>
              {label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      }
    >
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No closed runs {windowPhrase(statistics.window)}
        </p>
      ) : (
        <>
          <ChartContainer
            config={outcomeConfig}
            className="aspect-auto w-full"
            style={{ height: rows.length * 32 + 44 }}
          >
            <BarChart
              data={data}
              layout="vertical"
              margin={{ top: 0, right: 8, bottom: 0, left: 0 }}
            >
              <XAxis type="number" allowDecimals={false} tickLine={false} axisLine={false} />
              <YAxis
                type="category"
                dataKey="name"
                tickLine={false}
                axisLine={false}
                width={dimension === "model" ? 220 : 128}
                tickFormatter={(name: string) =>
                  name.length > 34 ? `${name.slice(0, 33)}…` : name
                }
              />
              <ChartTooltip
                cursor={{ fill: "var(--muted)", fillOpacity: 0.5 }}
                content={<ChartTooltipContent className="border-0 bg-popover shadow-raised" />}
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
                  maxBarSize={20}
                  isAnimationActive={false}
                />
              ))}
            </BarChart>
          </ChartContainer>
          <div className="-mx-2">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>
                    {dimensions.find(({ value }) => value === dimension)?.label}
                  </TableHead>
                  <TableHead className="text-right">
                    {unit === "run" ? "Runs" : "Attempts"}
                  </TableHead>
                  <TableHead className="text-right">Succeeded</TableHead>
                  <TableHead className="text-right max-sm:hidden">Median time</TableHead>
                  <TableHead className="text-right max-md:hidden">p90</TableHead>
                  <TableHead className="text-right max-md:hidden">Tokens per {unit}</TableHead>
                  <TableHead className="text-right max-sm:hidden">Cost per {unit}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map(({ name, outcomes, time, usage }) => (
                  <TableRow key={name} className="hover:bg-transparent">
                    <TableCell
                      className={
                        dimension === "model"
                          ? "w-full max-w-0 truncate font-mono text-xs"
                          : "w-full max-w-0 truncate"
                      }
                      title={name}
                    >
                      {name}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {outcomeTotal(outcomes).toLocaleString("en")}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {percentLabel(outcomes.succeeded, outcomeTotal(outcomes))}
                    </TableCell>
                    <TableCell className="text-right tabular-nums max-sm:hidden">
                      {time === null ? "None" : spanLabel(time.medianMillis)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums max-md:hidden">
                      {time === null ? "None" : spanLabel(time.p90Millis)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums max-md:hidden">
                      {usage.meanTokens === null ? "None" : tokensLabel(usage.meanTokens)}
                    </TableCell>
                    <TableCell
                      className="text-right tabular-nums max-sm:hidden"
                      title={
                        usage.cost === null
                          ? `No ${unit} has a price for every session`
                          : `${usage.cost.priced} of ${usage.measured} priced${usage.cost.estimate ? ", estimate" : ""}`
                      }
                    >
                      {usage.cost === null ? (
                        <span className="text-muted-foreground">No price</span>
                      ) : (
                        usdLabel(usage.cost.meanUsd)
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </>
      )}
    </StatisticsBlock>
  );
};
