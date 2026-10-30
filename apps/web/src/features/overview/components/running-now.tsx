import { upgradeWaitLine } from "~/lib/runs/strings";
import { WarningIcon } from "@phosphor-icons/react";
import type { FactoryOverview, RunningAttemptView, WorkerView } from "@usine/orchestrator/operator";
import { Option } from "effect";
import { FillCell } from "~/components/fill-cell";
import { ItemHeading } from "~/components/item/heading";
import { itemIdentity, useOverview } from "~/components/item/identity";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";
import { UsineMark } from "~/components/usine-mark";
import { agoLabel, dayTimeLabel, timestampLabel } from "~/lib/strings";
import { nothingRunning, warningLine } from "~/features/overview/strings";
import { EmptyLine, RunPageLink, RunRow } from "~/components/overview/section";

/** Formats `instant` as a time when it is today, otherwise as a day and time. */
const startLabel = (instant: string, now: number): string => {
  const start = new Date(instant);
  return start.toDateString() === new Date(now).toDateString()
    ? timestampLabel(instant).slice(11)
    : dayTimeLabel(instant);
};

/** Marks the Loop of an Attempt in flight, in the Loop column or, below `md`, the second line. */
const RunningMark = () => (
  <UsineMark running className="mr-2 inline-block size-3 align-middle text-run-active" />
);

type RunningRowProps = {
  readonly running: RunningAttemptView;
  readonly overview: FactoryOverview | undefined;
  readonly now: number;
};

const RunningRow = ({ running, overview, now }: RunningRowProps) => {
  const { run, attempt, item, lastActivityAt, warnings } = running;
  const origin = item === null ? null : itemIdentity(overview, item).origin;
  return (
    <RunRow run={run}>
      <FillCell className="py-3 whitespace-normal align-top">
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
        {run.approvalReason !== null && (
          <p className="mt-0.5 text-xs text-muted-foreground wrap-anywhere">{run.approvalReason}</p>
        )}
        <p className="mt-0.5 truncate text-xs text-muted-foreground lg:hidden">
          <span className="md:hidden">
            <RunningMark />
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
      </FillCell>
      <TableCell className="py-3 max-md:hidden align-top">
        <RunningMark />
        {run.loop}
      </TableCell>
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

type RunningNowProps = {
  readonly running: ReadonlyArray<RunningAttemptView>;
  readonly workers: ReadonlyArray<WorkerView>;
  readonly now: number;
};

export const RunningNow = ({ running, workers, now }: RunningNowProps) => {
  const overview = useOverview();
  const upgrade = workers.find((worker) => worker.upgradeWait !== null)?.upgradeWait;
  return (
    <>
      {upgrade != null && (
        <p role="status" className="mb-3 text-sm text-muted-foreground">
          {upgradeWaitLine(upgrade)}
        </p>
      )}
      {running.length === 0 ? (
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
      )}
    </>
  );
};
