import { CaretRightIcon } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import type {
  DurationSummaryView,
  RunStatisticsView,
  StatisticsWindow,
} from "@usine/orchestrator/operator";
import { ErrorAlert } from "~/components/error-alert";
import { Button } from "~/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "~/components/ui/collapsible";
import { Skeleton } from "~/components/ui/skeleton";
import { cn } from "~/lib/utils";
import { Breakdown } from "~/features/overview/components/statistics/breakdown";
import {
  AttemptsChart,
  NeedsAttentionChart,
  StatisticsBlock,
  ThroughputChart,
  UtilizationMeters,
} from "~/features/overview/components/statistics/charts";
import {
  countLabel,
  oneAttemptShare,
  outcomeTotal,
  percentLabel,
  spanLabel,
  windowPhrase,
} from "~/features/overview/lib/statistics/strings";
import { runStatisticsQuery } from "~/features/overview/queries";

/** A label over a value and an optional number with its unit. */
const Figure = ({
  label,
  value,
  detail,
}: {
  readonly label: string;
  readonly value: string;
  readonly detail?: string | undefined;
}) => (
  <div className="flex min-w-0 flex-col gap-0.5">
    <dt className="text-xs text-muted-foreground">{label}</dt>
    <dd className="text-lg font-semibold">{value}</dd>
    {detail !== undefined && (
      <dd className="text-xs text-muted-foreground tabular-nums">{detail}</dd>
    )}
  </div>
);

const median = (summary: DurationSummaryView | null): string =>
  summary === null ? "None" : spanLabel(summary.medianMillis);

const Empty = ({ children }: { readonly children: string }) => (
  <p className="text-sm text-muted-foreground">{children}</p>
);

const RunDetails = ({ statistics }: { readonly statistics: RunStatisticsView }) => {
  const closed = outcomeTotal(statistics.runs);
  const phrase = windowPhrase(statistics.window);
  const attention = statistics.needsAttention;
  return (
    <div className="flex flex-col gap-7">
      <dl className="grid grid-cols-2 gap-x-8 gap-y-4 sm:grid-cols-4">
        <Figure
          label="Runs closed"
          value={closed.toLocaleString("en")}
          detail={
            closed === 0
              ? undefined
              : `${percentLabel(statistics.runs.succeeded, closed)} succeeded`
          }
        />
        <Figure label="Median run time" value={median(statistics.runTime)} />
        <Figure label="Median attempt time" value={median(statistics.attemptTime)} />
        <Figure
          label="Runs in one attempt"
          value={
            statistics.attemptsPerRun.length === 0
              ? "None"
              : oneAttemptShare(statistics.attemptsPerRun)
          }
        />
      </dl>
      <div className="grid gap-x-10 gap-y-7 lg:grid-cols-2">
        <StatisticsBlock
          title={statistics.bucket === "day" ? "Runs closed per day" : "Runs closed per week"}
        >
          {closed === 0 ? (
            <Empty>{`No closed runs ${phrase}`}</Empty>
          ) : (
            <ThroughputChart periods={statistics.throughput} bucket={statistics.bucket} />
          )}
        </StatisticsBlock>
        <StatisticsBlock title={`Needs attention entries per ${statistics.bucket}`}>
          {attention.approvals + attention.failures === 0 ? (
            <Empty>{`No approvals or failures ${phrase}`}</Empty>
          ) : (
            <div className="flex flex-col gap-3">
              <NeedsAttentionChart periods={attention.periods} bucket={statistics.bucket} />
              <dl className="grid grid-cols-2 gap-x-8">
                <Figure label="Median approval wait" value={median(attention.approvalWait)} />
                <Figure label="Median failure to retry" value={median(attention.retryWait)} />
              </dl>
            </div>
          )}
        </StatisticsBlock>
      </div>
      <Breakdown statistics={statistics} />
      <div className="grid gap-x-10 gap-y-7 sm:grid-cols-2 xl:grid-cols-3">
        <StatisticsBlock title="Attempts per run">
          {statistics.attemptsPerRun.length === 0 ? (
            <Empty>{`No closed runs with an attempt ${phrase}`}</Empty>
          ) : (
            <AttemptsChart counts={statistics.attemptsPerRun} />
          )}
        </StatisticsBlock>
        <StatisticsBlock title="Queue wait">
          {statistics.queueWait.length === 0 ? (
            <Empty>{`No attempts started ${phrase}`}</Empty>
          ) : (
            <dl className="flex flex-col gap-2.5">
              {statistics.queueWait.map(({ worker, wait }) => (
                <div key={worker} className="flex items-baseline justify-between gap-3">
                  <dt className="truncate font-mono text-xs text-foreground">{worker}</dt>
                  <dd className="text-sm font-medium tabular-nums">{median(wait)}</dd>
                </div>
              ))}
            </dl>
          )}
        </StatisticsBlock>
        <StatisticsBlock title="Worker utilization">
          {statistics.utilization.length === 0 ? (
            <Empty>No workers in usine.yaml</Empty>
          ) : (
            <UtilizationMeters workers={statistics.utilization} />
          )}
        </StatisticsBlock>
      </div>
      {statistics.unmeasuredAttempts > 0 && (
        <p className="text-xs text-muted-foreground">
          {countLabel(statistics.unmeasuredAttempts, "attempt", "attempts")} without an end time{" "}
          {statistics.unmeasuredAttempts === 1 ? "is" : "are"} left out of attempt time
        </p>
      )}
    </div>
  );
};

const LoadingDetails = () => (
  <div aria-hidden="true" className="grid grid-cols-2 gap-x-8 gap-y-4 sm:grid-cols-4">
    {[0, 1, 2, 3].map((figure) => (
      <div key={figure} className="flex flex-col gap-2">
        <Skeleton className="h-3 w-20" />
        <Skeleton className="h-5 w-14" />
      </div>
    ))}
  </div>
);

const DetailsPanel = ({ window }: { readonly window: StatisticsWindow }) => {
  const query = useQuery(runStatisticsQuery(window));
  const statistics = query.data;
  if (statistics === undefined)
    return query.isError ? (
      <ErrorAlert title="Could not load the run statistics" message={query.error.message} />
    ) : (
      <LoadingDetails />
    );
  return (
    <div
      aria-busy={query.isPlaceholderData}
      className={cn(
        "transition-opacity duration-(--duration-fast)",
        query.isPlaceholderData && "opacity-60",
      )}
    >
      <RunDetails statistics={statistics} />
    </div>
  );
};

/** The run statistics behind a disclosure, read only once it opens. */
export const Details = ({ window }: { readonly window: StatisticsWindow }) => (
  <Collapsible className="flex flex-col gap-4">
    <CollapsibleTrigger
      render={
        <Button
          variant="ghost"
          size="sm"
          className="-mx-2 w-fit gap-1.5 px-2 text-sm font-medium text-muted-foreground hover:text-foreground data-[panel-open]:text-foreground data-[panel-open]:[&>svg]:rotate-90"
        />
      }
    >
      <CaretRightIcon
        aria-hidden="true"
        className="transition-transform duration-(--duration-fast)"
      />
      Details
    </CollapsibleTrigger>
    <CollapsibleContent>
      <DetailsPanel window={window} />
    </CollapsibleContent>
  </Collapsible>
);
