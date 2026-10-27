import type { ClosedRunView, FactoryOverview } from "@usine/orchestrator/operator";
import { Option } from "effect";
import { FillCell } from "~/components/fill-cell";
import { ItemHeading } from "~/components/item/heading";
import { cardIdentity, pullRequestAt, taskCard, useOverview } from "~/components/item/identity";
import { ItemMark } from "~/components/item/mark";
import { StatusBadge } from "~/components/status-badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";
import { agoLabel, timestampLabel } from "~/lib/strings";
import { EmptyLine, RunPageLink, RunRow } from "~/components/overview/section";

type OutcomeRowProps = {
  readonly closed: ClosedRunView;
  readonly overview: FactoryOverview | undefined;
  readonly now: number;
};

const OutcomeRow = ({ closed, overview, now }: OutcomeRowProps) => {
  const { run, item, closedAt } = closed;
  const card = taskCard(overview, run.itemKey);
  const origin = Option.match(card, {
    onNone: () => item,
    onSome: (found) => cardIdentity(found).origin,
  });
  const pullRequest = Option.filter(
    Option.flatMap(Option.fromNullishOr(run.pullRequestUrl), (url) =>
      pullRequestAt(url, Option.match(card, { onNone: () => [], onSome: ({ items }) => items })),
    ),
    ({ number }) => number !== origin?.number,
  );
  return (
    <RunRow run={run}>
      <FillCell className="py-3">
        <RunPageLink run={run}>
          {origin === null ? (
            <span className="block truncate text-sm font-medium">
              Run <span className="font-mono text-xs">{run.id.slice(0, 8)}</span>
            </span>
          ) : (
            <ItemHeading
              variant="row"
              item={Option.some(origin)}
              title={origin.title}
              linked={false}
            />
          )}
        </RunPageLink>
        <p className="mt-0.5 truncate text-xs text-muted-foreground md:hidden">{run.loop}</p>
      </FillCell>
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
          Option.match(pullRequest, {
            onNone: () => null,
            onSome: (found) => <ItemMark item={found} />,
          })
        )}
      </TableCell>
    </RunRow>
  );
};

type LastOutcomesProps = {
  readonly outcomes: ReadonlyArray<ClosedRunView>;
  readonly now: number;
};

/** Renders the most recently closed Runs, newest first; each row links to its Run page. */
export const LastOutcomes = ({ outcomes, now }: LastOutcomesProps) => {
  const overview = useOverview();
  return outcomes.length === 0 ? (
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
            <OutcomeRow key={closed.run.id} closed={closed} overview={overview} now={now} />
          ))}
        </TableBody>
      </Table>
    </div>
  );
};
