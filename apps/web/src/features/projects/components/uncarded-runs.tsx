import { ArrowUpRightIcon } from "@phosphor-icons/react";
import { RunId } from "@usine/core/run";
import type { RunView } from "@usine/orchestrator/operator";
import { StatusBadge } from "~/components/status-badge";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";

type UncardedRunsProps = {
  readonly runs: ReadonlyArray<RunView>;
  readonly openRun: (runId: RunId) => void;
};

export const UncardedRuns = ({ runs, openRun }: UncardedRunsProps) => (
  // Sticks to the left edge of the Board's scroll area and is no wider than the scroll container.
  <Card className="sticky left-4 w-[min(64rem,calc(100cqw-2rem))] md:left-5 md:w-[min(64rem,calc(100cqw-2.5rem))]">
    <CardHeader>
      <CardTitle>Runs without a card</CardTitle>
      <CardDescription>
        {runs.length} run{runs.length === 1 ? "" : "s"} with no card on this board
      </CardDescription>
    </CardHeader>
    <CardContent>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Loop</TableHead>
            <TableHead>Agent</TableHead>
            <TableHead>Item</TableHead>
            <TableHead>State</TableHead>
            <TableHead className="w-0" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {runs.map((run) => (
            <TableRow key={run.id} className="cursor-pointer" onClick={() => openRun(run.id)}>
              <TableCell className="font-medium">{run.loop}</TableCell>
              <TableCell>{run.agent}</TableCell>
              <TableCell className="max-w-64 truncate font-mono text-xs">{run.itemKey}</TableCell>
              <TableCell>
                <StatusBadge state={run.state} />
              </TableCell>
              <TableCell className="text-right">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Open run ${run.id}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    openRun(run.id);
                  }}
                >
                  <ArrowUpRightIcon aria-hidden="true" />
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </CardContent>
  </Card>
);
