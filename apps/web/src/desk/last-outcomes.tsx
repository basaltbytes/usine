import type { ClosedRunView } from "@usine/orchestrator/operator";
import { StatusBadge } from "@/components/status-badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { agoLabel, timestampLabel } from "../operator-copy.ts";
import { pullRequestLabel } from "./copy.ts";
import { EmptyLine, ItemTitle, RunPageLink, RunRow } from "./section.tsx";

const OutcomeRow = ({ closed, now }: { readonly closed: ClosedRunView; readonly now: number }) => {
  const { run, item, closedAt } = closed;
  return (
    <RunRow run={run}>
      <TableCell className="w-full max-w-0 py-3">
        <RunPageLink run={run}>
          <ItemTitle item={item} run={run} />
        </RunPageLink>
        <p className="mt-0.5 truncate text-xs text-muted-foreground md:hidden">{run.loop}</p>
      </TableCell>
      <TableCell className="py-3 max-md:hidden">{run.loop}</TableCell>
      <TableCell className="py-3">
        <StatusBadge state={run.state} />
      </TableCell>
      <TableCell className="py-3 text-right max-sm:hidden">
        <time
          dateTime={closedAt}
          title={timestampLabel(closedAt)}
          className="text-xs text-muted-foreground tabular-nums"
        >
          {agoLabel(closedAt, now)}
        </time>
      </TableCell>
      <TableCell className="py-3 text-right">
        {run.pullRequestUrl === null ? (
          <span className="text-xs text-muted-foreground">None</span>
        ) : (
          <a
            href={run.pullRequestUrl}
            target="_blank"
            rel="noreferrer"
            onClick={(event) => event.stopPropagation()}
            className="rounded-sm font-mono text-xs text-primary underline-offset-4 outline-none hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring/70 focus-visible:outline-solid"
          >
            {pullRequestLabel(run.pullRequestUrl)}
          </a>
        )}
      </TableCell>
    </RunRow>
  );
};

/** Renders the most recently closed Runs, newest first; each row links to its Run page. */
export const LastOutcomes = ({
  outcomes,
  now,
}: {
  readonly outcomes: ReadonlyArray<ClosedRunView>;
  readonly now: number;
}) =>
  outcomes.length === 0 ? (
    <EmptyLine>No recent runs</EmptyLine>
  ) : (
    <div className="-mx-2">
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead>Item</TableHead>
            <TableHead className="max-md:hidden">Loop</TableHead>
            <TableHead>Outcome</TableHead>
            <TableHead className="text-right max-sm:hidden">Closed</TableHead>
            <TableHead className="text-right">Pull request</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {outcomes.map((closed) => (
            <OutcomeRow key={closed.run.id} closed={closed} now={now} />
          ))}
        </TableBody>
      </Table>
    </div>
  );
