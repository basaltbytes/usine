import { useQuery } from "@tanstack/react-query";
import type {
  DurationSummaryView,
  StatisticsView,
  StatisticsWindow,
} from "@usine/orchestrator/operator";
import { useState } from "react";
import { ErrorAlert } from "@/components/error-alert";
import { Skeleton } from "@/components/ui/skeleton";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";
import { tokensLabel } from "../../operator-copy.ts";
import { DeskSection, EmptyLine } from "../section.tsx";
import { Breakdown } from "./breakdown.tsx";
import {
  AttemptsChart,
  NeedsAttentionChart,
  OutcomeMix,
  StatisticsBlock,
  ThroughputChart,
  UtilizationMeters,
} from "./charts.tsx";
import {
  attemptsReading,
  costDetail,
  costValue,
  countLabel,
  firstPassReading,
  medianLabel,
  needsAttentionReading,
  outcomeReading,
  outcomeTotal,
  percentLabel,
  queueWaitReading,
  spreadLabel,
  throughputReading,
  tokensDetail,
  utilizationReading,
  windowLabels,
  windowNote,
  windowPhrase,
} from "./copy.ts";
import { statisticsQuery } from "./query.ts";

const WINDOWS: ReadonlyArray<StatisticsWindow> = ["7d", "30d", "all"];

const isWindow = (value: string | undefined): value is StatisticsWindow =>
  WINDOWS.some((window) => window === value);

/** A single value with its label above and a 12px detail line below. */
const Figure = ({
  label,
  value,
  detail,
}: {
  readonly label: string;
  readonly value: string;
  readonly detail: string;
}) => (
  <div className="flex min-w-0 flex-col gap-0.5">
    <dt className="text-xs text-muted-foreground">{label}</dt>
    <dd className="text-xl font-semibold tabular-nums">{value}</dd>
    <dd className="text-xs text-muted-foreground tabular-nums">{detail}</dd>
  </div>
);

/** Returns a figure whose value is the median of `summary`, with the spread as its detail. */
const durationFigure = (
  label: string,
  summary: DurationSummaryView | null,
  empty: string,
): { readonly label: string; readonly value: string; readonly detail: string } =>
  summary === null
    ? { label, value: "None", detail: empty }
    : { label, value: medianLabel(summary), detail: spreadLabel(summary) };

const Figures = ({ statistics }: { readonly statistics: StatisticsView }) => {
  const closed = outcomeTotal(statistics.runs);
  const phrase = windowPhrase(statistics.window);
  const figures = [
    {
      label: "Runs closed",
      value: closed.toLocaleString("en"),
      detail:
        closed === 0
          ? `No closed runs ${phrase}`
          : `${percentLabel(statistics.runs.succeeded, closed)} succeeded`,
    },
    durationFigure("Median run time", statistics.runTime, `No closed runs ${phrase}`),
    statistics.attemptTime === null
      ? durationFigure(
          "Median attempt time",
          null,
          statistics.unmeasuredAttempts > 0
            ? "No attempt end recorded"
            : `No ended attempts ${phrase}`,
        )
      : {
          label: "Median attempt time",
          value: medianLabel(statistics.attemptTime),
          detail:
            statistics.unmeasuredAttempts === 0
              ? spreadLabel(statistics.attemptTime)
              : `${spreadLabel(statistics.attemptTime)}; ${statistics.unmeasuredAttempts} without an end time`,
        },
    {
      label: "Cost per run",
      value: costValue(statistics.usage),
      detail: costDetail(statistics.usage, "run"),
    },
    {
      label: "Tokens per run",
      value:
        statistics.usage.meanTokens === null ? "None" : tokensLabel(statistics.usage.meanTokens),
      detail: tokensDetail(statistics.usage),
    },
  ];
  return (
    <dl className="grid grid-cols-2 gap-x-8 gap-y-5 sm:grid-cols-3 xl:grid-cols-5">
      {figures.map((figure) => (
        <Figure key={figure.label} {...figure} />
      ))}
    </dl>
  );
};

const PullRequests = ({ statistics }: { readonly statistics: StatisticsView }) => {
  const { firstPass, leadTime } = statistics;
  const phrase = windowPhrase(statistics.window);
  return (
    <StatisticsBlock
      title="Merged pull requests"
      reading={
        firstPass.merged === 0
          ? `No merged pull requests with a run ${phrase}`
          : firstPassReading(firstPass)
      }
    >
      {firstPass.merged > 0 && (
        <dl className="grid grid-cols-2 gap-x-8 gap-y-5">
          <Figure
            label="First pass"
            value={percentLabel(firstPass.firstPass, firstPass.merged)}
            detail={`${firstPass.firstPass} of ${countLabel(firstPass.merged, "pull request", "pull requests")}`}
          />
          {leadTime !== null && (
            <Figure
              label="Median lead time"
              value={medianLabel(leadTime)}
              detail={`${spreadLabel(leadTime)}, from first run to merge`}
            />
          )}
        </dl>
      )}
    </StatisticsBlock>
  );
};

const QueueWait = ({ statistics }: { readonly statistics: StatisticsView }) => (
  <StatisticsBlock
    title="Queue wait"
    reading={
      statistics.queueWait.length === 0
        ? `No attempts started ${windowPhrase(statistics.window)}`
        : queueWaitReading(statistics.queueWait)
    }
  >
    {statistics.queueWait.length > 0 && (
      <dl className="flex flex-col gap-3">
        {statistics.queueWait.map(({ worker, wait }) => (
          <div key={worker} className="flex flex-col gap-0.5">
            <dt className="truncate font-mono text-xs text-foreground">{worker}</dt>
            <dd className="text-sm font-medium tabular-nums">Median {medianLabel(wait)}</dd>
            <dd className="text-xs text-muted-foreground tabular-nums">
              {spreadLabel(wait)}, {countLabel(wait.count, "run", "runs")}
            </dd>
          </div>
        ))}
      </dl>
    )}
  </StatisticsBlock>
);

const NeedsAttention = ({ statistics }: { readonly statistics: StatisticsView }) => {
  const attention = statistics.needsAttention;
  const empty = attention.approvals + attention.failures === 0;
  return (
    <StatisticsBlock
      title={`Needs attention entries per ${statistics.bucket}`}
      reading={
        empty
          ? `No approvals or failures ${windowPhrase(statistics.window)}`
          : needsAttentionReading(attention)
      }
    >
      {!empty && (
        <div className="grid gap-x-10 gap-y-5 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
          <NeedsAttentionChart periods={attention.periods} bucket={statistics.bucket} />
          <dl className="grid grid-cols-2 content-start gap-x-8 gap-y-5 lg:grid-cols-1">
            <Figure
              {...durationFigure(
                "Median approval wait",
                attention.approvalWait,
                "No approvals given",
              )}
            />
            <Figure
              {...durationFigure(
                "Median failure to retry",
                attention.retryWait,
                "No failures retried; marking one resolved records no time",
              )}
            />
          </dl>
        </div>
      )}
    </StatisticsBlock>
  );
};

const StatisticsBody = ({ statistics }: { readonly statistics: StatisticsView }) => {
  const closed = outcomeTotal(statistics.runs);
  const phrase = windowPhrase(statistics.window);
  return (
    <div className="flex flex-col gap-9">
      <Figures statistics={statistics} />
      <div className="grid gap-x-10 gap-y-9 lg:grid-cols-2">
        <StatisticsBlock
          title={statistics.bucket === "day" ? "Runs closed per day" : "Runs closed per week"}
          reading={
            closed === 0
              ? `No closed runs ${phrase}`
              : throughputReading(statistics.throughput, statistics.bucket)
          }
        >
          {closed > 0 && (
            <ThroughputChart periods={statistics.throughput} bucket={statistics.bucket} />
          )}
        </StatisticsBlock>
        <div className="flex flex-col gap-9">
          <StatisticsBlock
            title="Outcomes"
            reading={closed === 0 ? `No closed runs ${phrase}` : outcomeReading(statistics.runs)}
          >
            {closed > 0 && <OutcomeMix outcomes={statistics.runs} />}
          </StatisticsBlock>
          <PullRequests statistics={statistics} />
        </div>
      </div>
      <Breakdown statistics={statistics} />
      <div className="grid gap-x-10 gap-y-9 sm:grid-cols-2 xl:grid-cols-3">
        <StatisticsBlock
          title="Attempts per run"
          reading={
            statistics.attemptsPerRun.length === 0
              ? `No closed runs with an attempt ${phrase}`
              : attemptsReading(statistics.attemptsPerRun)
          }
        >
          {statistics.attemptsPerRun.length > 0 && (
            <AttemptsChart counts={statistics.attemptsPerRun} />
          )}
        </StatisticsBlock>
        <QueueWait statistics={statistics} />
        <StatisticsBlock
          title="Worker utilization"
          reading={utilizationReading(statistics.utilization)}
        >
          {statistics.utilization.length > 0 && (
            <UtilizationMeters workers={statistics.utilization} />
          )}
        </StatisticsBlock>
      </div>
      <NeedsAttention statistics={statistics} />
    </div>
  );
};

const LoadingStatistics = () => (
  <div
    aria-hidden="true"
    className="grid grid-cols-2 gap-x-8 gap-y-5 sm:grid-cols-3 xl:grid-cols-5"
  >
    {[0, 1, 2, 3, 4].map((figure) => (
      <div key={figure} className="flex flex-col gap-2">
        <Skeleton className="h-3 w-20" />
        <Skeleton className="h-5 w-16" />
      </div>
    ))}
  </div>
);

/** Renders the Statistics section of the Overview, with a switch between 7 days, 30 days, and all. */
export const Statistics = () => {
  const [selected, setSelected] = useState<StatisticsWindow>("30d");
  const query = useQuery(statisticsQuery(selected));
  const statistics = query.data;
  return (
    <DeskSection
      id="desk-statistics"
      title="Statistics"
      note={statistics === undefined ? undefined : windowNote(statistics.from, statistics.bucket)}
      actions={
        <ToggleGroup
          aria-label="Statistics window"
          variant="outline"
          size="sm"
          spacing={0}
          value={[selected]}
          onValueChange={([value]) => {
            if (isWindow(value)) setSelected(value);
          }}
        >
          {WINDOWS.map((option) => (
            <ToggleGroupItem key={option} value={option}>
              {windowLabels[option]}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      }
    >
      {statistics === undefined ? (
        query.isError ? (
          <ErrorAlert title="Could not load the statistics" message={query.error.message} />
        ) : (
          <LoadingStatistics />
        )
      ) : (
        <div
          aria-busy={query.isPlaceholderData}
          className={cn(
            "pt-2 transition-opacity duration-(--duration-fast)",
            query.isPlaceholderData && "opacity-60",
          )}
        >
          {query.isError && (
            <EmptyLine>Could not refresh the statistics: {query.error.message}</EmptyLine>
          )}
          <StatisticsBody statistics={statistics} />
        </div>
      )}
    </DeskSection>
  );
};
