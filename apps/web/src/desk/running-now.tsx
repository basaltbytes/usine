import { WarningIcon } from "@phosphor-icons/react";
import type { FactoryOverview, RunningAttemptView, WorkerView } from "@usine/orchestrator/operator";
import { Option } from "effect";
import { ItemHeading } from "@/components/item/heading";
import { itemIdentity, useOverview } from "@/components/item/identity";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { agoLabel, dayTimeLabel, timestampLabel } from "../operator-copy.ts";
import { nothingRunning, warningLine } from "./copy.ts";
import { EmptyLine, RunPageLink, RunRow } from "./section.tsx";

/** Formats `instant` as a time when it is today, otherwise as a day and time. */
const startLabel = (instant: string, now: number): string => {
  const start = new Date(instant);
  return start.toDateString() === new Date(now).toDateString()
    ? timestampLabel(instant).slice(11)
    : dayTimeLabel(instant);
};

const RunningRow = ({
  running,
  overview,
  now,
}: {
  readonly running: RunningAttemptView;
  readonly overview: FactoryOverview | undefined;
  readonly now: number;
}) => {
  const { run, attempt, item, lastActivityAt, warnings } = running;
  const origin = item === null ? null : itemIdentity(overview, item).origin;
  return (
    <RunRow run={run}>
      <TableCell className="w-full max-w-0 py-3 whitespace-normal align-top">
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
        <p className="mt-0.5 truncate text-xs text-muted-foreground lg:hidden">
          <span className="md:hidden">
            {run.loop}, {run.agent} on {attempt.worker}
          </span>
          <span className="max-md:hidden">
            {run.agent} on {attempt.worker}
          </span>
        </p>
        {warnings.map((warning) => (
          <p
            key={warning._tag === "WorkerSilent" ? warning.worker : `${warning.agent}`}
            className="mt-1 flex items-start gap-1.5 text-xs text-warning"
          >
            <WarningIcon aria-hidden="true" weight="fill" className="mt-0.5 size-3 shrink-0" />
            <span>
              {warningLine(warning)}
              {warning._tag === "ProviderRetrying" && (
                <span className="block text-warning/80 wrap-anywhere">{warning.message}</span>
              )}
            </span>
          </p>
        ))}
      </TableCell>
      <TableCell className="py-3 max-md:hidden align-top">{run.loop}</TableCell>
      <TableCell className="py-3 max-lg:hidden align-top">{run.agent}</TableCell>
      <TableCell className="py-3 max-lg:hidden align-top">{attempt.worker}</TableCell>
      <TableCell className="py-3 max-sm:hidden align-top">
        <time
          dateTime={attempt.startedAt}
          title={timestampLabel(attempt.startedAt)}
          className="font-mono text-xs tabular-nums"
        >
          {startLabel(attempt.startedAt, now)}
        </time>
      </TableCell>
      <TableCell className="py-3 text-right align-top">
        {lastActivityAt === null ? (
          <span className="text-xs text-muted-foreground">None yet</span>
        ) : (
          <time
            dateTime={lastActivityAt}
            title={timestampLabel(lastActivityAt)}
            className="text-xs text-muted-foreground tabular-nums"
          >
            {agoLabel(lastActivityAt, now)}
          </time>
        )}
      </TableCell>
    </RunRow>
  );
};

export const RunningNow = ({
  running,
  workers,
  now,
}: {
  readonly running: ReadonlyArray<RunningAttemptView>;
  readonly workers: ReadonlyArray<WorkerView>;
  readonly now: number;
}) => {
  const overview = useOverview();
  return running.length === 0 ? (
    <EmptyLine>{nothingRunning(workers)}</EmptyLine>
  ) : (
    <div className="-mx-2">
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead>Item</TableHead>
            <TableHead className="max-md:hidden">Loop</TableHead>
            <TableHead className="max-lg:hidden">Agent</TableHead>
            <TableHead className="max-lg:hidden">Worker</TableHead>
            <TableHead className="max-sm:hidden">Started</TableHead>
            <TableHead className="text-right">Last activity</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {running.map((entry) => (
            <RunningRow key={entry.attempt.id} running={entry} overview={overview} now={now} />
          ))}
        </TableBody>
      </Table>
    </div>
  );
};
