import { useQuery } from "@tanstack/react-query";
import type { StatisticsView, StatisticsWindow } from "@usine/orchestrator/operator";
import { type ReactNode, useState } from "react";
import { ErrorAlert } from "~/components/error-alert";
import { DeskSection, EmptyLine } from "~/components/overview/section";
import { Skeleton } from "~/components/ui/skeleton";
import { ToggleGroup, ToggleGroupItem } from "~/components/ui/toggle-group";
import { Details } from "~/features/overview/components/statistics/details";
import { FirstTimeRight } from "~/features/overview/components/statistics/first-time-right";
import {
  loopParts,
  ShareBar,
  waitingPart,
} from "~/features/overview/components/statistics/share-bar";
import { TasksDoneChart } from "~/features/overview/components/statistics/tasks-done/chart";
import { TasksDoneLegend } from "~/features/overview/components/statistics/tasks-done/legend";
import { statisticsQuery } from "~/features/overview/queries";
import {
  aboutLabel,
  noTasksLine,
  spanLabel,
  unmeteredLine,
  unpricedLine,
  untimedLine,
  windowLabels,
  windowNote,
} from "~/features/overview/strings";
import { tokensLabel, usdLabel } from "~/lib/strings";
import { cn } from "~/lib/utils";

const WINDOWS: ReadonlyArray<StatisticsWindow> = ["7d", "30d", "all"];

const isWindow = (value: string | undefined): value is StatisticsWindow =>
  WINDOWS.some((window) => window === value);

type FigureProps = { readonly value: string; readonly unit: string };

/** A 20px value followed by its unit in 13px subtext0. */
const Figure = ({ value, unit }: FigureProps) => (
  <p className="flex min-w-0 items-baseline gap-1.5">
    <span className="text-xl font-semibold">{value}</span>{" "}
    <span className="text-sm text-muted-foreground">{unit}</span>
  </p>
);

type TaskBlockProps = {
  readonly title: string;
  readonly className?: string;
  readonly children: ReactNode;
};

/** A block of the section: a 14px title, then its figures and chart. */
const TaskBlock = ({ title, className, children }: TaskBlockProps) => (
  <section className={cn("flex min-w-0 flex-col gap-3", className)}>
    <h3 className="text-md font-medium">{title}</h3>
    {children}
  </section>
);

type TimePerTaskProps = { readonly statistics: StatisticsView };

const TimePerTask = ({ statistics }: TimePerTaskProps) => {
  const { time } = statistics;
  return (
    <TaskBlock title="Time per task">
      {time === null ? (
        <EmptyLine>No task with recorded attempt times</EmptyLine>
      ) : (
        <>
          <ShareBar
            label="Time per task"
            parts={[...loopParts(statistics.loops, time.loops), waitingPart(time.waiting)]}
          />
          <ul className="flex flex-col gap-1 text-sm text-muted-foreground">
            {time.runs.map(({ loop, medianMillis }) => (
              <li key={loop}>
                <span className="text-foreground">{loop}</span> {aboutLabel(medianMillis)}
              </li>
            ))}
          </ul>
        </>
      )}
    </TaskBlock>
  );
};

type TokensPerTaskProps = { readonly statistics: StatisticsView };

const TokensPerTask = ({ statistics }: TokensPerTaskProps) => {
  const { tokens } = statistics;
  return (
    <TaskBlock title="Tokens per task">
      {tokens === null ? (
        <EmptyLine>No token reports</EmptyLine>
      ) : (
        <>
          <Figure value={tokensLabel(tokens.medianTokens)} unit="median" />
          <ShareBar label="Tokens per task" parts={loopParts(statistics.loops, tokens.loops)} />
        </>
      )}
    </TaskBlock>
  );
};

type StatisticsBodyProps = { readonly statistics: StatisticsView };

const StatisticsBody = ({ statistics }: StatisticsBodyProps) => {
  if (statistics.tasks.length === 0) return <EmptyLine>{noTasksLine(statistics.window)}</EmptyLine>;
  const { tokens } = statistics;
  const cost = tokens?.cost ?? null;
  const unpriced = tokens === null ? 0 : tokens.tasks - (cost?.tasks ?? 0);
  const gaps = [
    statistics.untimed === null ? null : untimedLine(statistics.untimed),
    statistics.unmetered === 0 ? null : unmeteredLine(statistics.unmetered),
    unpriced === 0 ? null : unpricedLine(unpriced),
  ].filter((gap) => gap !== null);
  return (
    <div className="flex flex-col gap-9">
      <div className="grid gap-x-12 gap-y-9 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <TaskBlock title="Tasks done" className="lg:col-span-2">
          <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-2">
            <div className="flex flex-wrap items-baseline gap-x-8 gap-y-1">
              <Figure
                value={statistics.tasks.length.toLocaleString("en")}
                unit={statistics.tasks.length === 1 ? "task" : "tasks"}
              />
              {statistics.medianMillis !== null && (
                <Figure value={spanLabel(statistics.medianMillis)} unit="median time in usine" />
              )}
              {cost !== null && (
                <Figure
                  value={`${cost.estimate ? "~" : ""}${usdLabel(cost.medianUsd)}`}
                  unit="median price"
                />
              )}
            </div>
            <TasksDoneLegend points={statistics.bucket === "day" ? "dot" : "column"} />
          </div>
          <TasksDoneChart statistics={statistics} />
        </TaskBlock>
        <TimePerTask statistics={statistics} />
        <TaskBlock title="First time right" className="lg:row-span-2">
          <FirstTimeRight statistics={statistics} />
        </TaskBlock>
        <TokensPerTask statistics={statistics} />
      </div>
      {gaps.length > 0 && <p className="text-xs text-muted-foreground">{gaps.join("; ")}</p>}
    </div>
  );
};

const LoadingStatistics = () => (
  <div aria-hidden="true" className="flex flex-col gap-3">
    <Skeleton className="h-4 w-24" />
    <div className="flex gap-8">
      <Skeleton className="h-6 w-20" />
      <Skeleton className="h-6 w-40" />
    </div>
    <Skeleton className="h-60 w-full" />
  </div>
);

/**
 * Renders the Statistics section of the Overview: the tasks done in 7 days, 30 days, or all, and
 * the run statistics behind a Details disclosure.
 */
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
      <div className="flex flex-col gap-6 pt-2">
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
              "transition-opacity duration-(--duration-fast)",
              query.isPlaceholderData && "opacity-60",
            )}
          >
            {query.isError && (
              <EmptyLine>Could not refresh the statistics: {query.error.message}</EmptyLine>
            )}
            <StatisticsBody statistics={statistics} />
          </div>
        )}
        <Details window={selected} />
      </div>
    </DeskSection>
  );
};
