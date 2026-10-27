import type {
  DurationSummaryView,
  OutcomeCountsView,
  RunStatisticsView,
  UsageSummaryView,
} from "@usine/orchestrator/operator";
import { useState } from "react";
import { FillCell } from "@/components/fill-cell";
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
import { StatisticsBlock } from "./charts.tsx";
import { outcomeTotal, percentLabel, spanLabel, windowPhrase } from "./copy.ts";

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

const rowsOf = (
  statistics: RunStatisticsView,
  dimension: Dimension,
): ReadonlyArray<BreakdownRow> => {
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

/** Closed runs per loop or agent, or ended attempts per model, with time, tokens, and cost. */
export const Breakdown = ({ statistics }: { readonly statistics: RunStatisticsView }) => {
  const [dimension, setDimension] = useState<Dimension>("loop");
  const rows = rowsOf(statistics, dimension);
  const unit = dimension === "model" ? "attempt" : "run";
  return (
    <StatisticsBlock
      title={dimension === "model" ? "Attempts per model" : `Runs per ${dimension}`}
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
        <div className="-mx-2">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>{dimensions.find(({ value }) => value === dimension)?.label}</TableHead>
                <TableHead className="text-right">{unit === "run" ? "Runs" : "Attempts"}</TableHead>
                <TableHead className="text-right">Succeeded</TableHead>
                <TableHead className="text-right max-sm:hidden">Median time</TableHead>
                <TableHead className="text-right max-md:hidden">Tokens per {unit}</TableHead>
                <TableHead className="text-right max-sm:hidden">Cost per {unit}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map(({ name, outcomes, time, usage }) => (
                <TableRow key={name} className="hover:bg-transparent">
                  <FillCell
                    className={dimension === "model" ? "truncate font-mono text-xs" : "truncate"}
                    title={name}
                  >
                    {name}
                  </FillCell>
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
      )}
    </StatisticsBlock>
  );
};
