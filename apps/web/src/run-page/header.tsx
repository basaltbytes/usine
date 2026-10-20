import type { RunDetailView, RunDurationView, RunView } from "@usine/orchestrator/operator";
import { Option } from "effect";
import type { ReactNode } from "react";
import { StateMark } from "@/components/status-badge";
import { useNow } from "@/hooks/use-now";
import { cn } from "@/lib/utils";
import { durationLabel, runStateLine } from "../operator-copy.ts";
import { pullRequestNumber, type RunItem } from "./item.ts";
import { UsageFact } from "./usage.tsx";

const external = { target: "_blank", rel: "noreferrer" } as const;

/**
 * The Item's number, linking to GitHub, and its title. A Run without an Item, or whose
 * title is unknown, is named by its Loop.
 */
export const RunTitle = ({
  run,
  item,
  heading,
  shared,
}: {
  readonly run: Pick<RunView, "loop" | "repository">;
  readonly item: Option.Option<RunItem>;
  /** Renders the title text in the caller's heading element and size. */
  readonly heading: (title: ReactNode) => ReactNode;
  /** Names the title for the drawer-to-page view transition; one shown title at a time may carry it. */
  readonly shared: boolean;
}) => (
  <div
    className="flex min-w-0 items-baseline gap-2.5"
    style={shared ? { viewTransitionName: "run-title" } : undefined}
  >
    {Option.match(item, {
      onNone: () => null,
      onSome: ({ number, url }) => (
        <a
          href={url}
          {...external}
          className="shrink-0 font-mono text-xs text-primary underline-offset-4 hover:underline"
        >
          #{number}
        </a>
      ),
    })}
    {heading(
      Option.getOrElse(
        Option.flatMap(item, ({ title }) => title),
        () => `${run.loop} on ${run.repository}`,
      ),
    )}
  </div>
);

/** The Run's state, its pull request or the lack of one, its Loop, and its Agent, on one line. */
export const RunFacts = ({
  run,
  item,
  shared,
  className,
}: {
  readonly run: Pick<
    RunView,
    "state" | "attempts" | "pullRequestUrl" | "loop" | "agent" | "loopPaused"
  >;
  /** A pull request Item is the Run's pull request when the Run produced none. */
  readonly item: Option.Option<RunItem>;
  /** Names the state for the drawer-to-page view transition, as on the title. */
  readonly shared: boolean;
  readonly className?: string;
}) => {
  const pullRequest =
    run.pullRequestUrl ??
    Option.getOrNull(
      Option.map(
        Option.filter(item, ({ pullRequest }) => pullRequest),
        ({ url }) => url,
      ),
    );
  return (
    <p
      className={cn(
        "flex flex-wrap items-center gap-x-5 gap-y-1 text-sm text-muted-foreground",
        className,
      )}
    >
      <span
        className="inline-flex items-center gap-2 font-medium text-foreground"
        style={shared ? { viewTransitionName: "run-state" } : undefined}
      >
        <StateMark state={run.state} />
        {runStateLine(run)}
      </span>
      {pullRequest === null ? (
        <span>No pull request</span>
      ) : (
        <a
          href={pullRequest}
          {...external}
          className="text-primary underline-offset-4 hover:underline"
        >
          Pull request
          {Option.match(pullRequestNumber(pullRequest), {
            onNone: () => null,
            onSome: (number) => <span className="font-mono text-xs"> #{number}</span>,
          })}
        </a>
      )}
      <span>
        Loop <span className="text-foreground">{run.loop}</span>
      </span>
      <span>
        Agent <span className="text-foreground">{run.agent}</span>
      </span>
      {run.loopPaused && <span>Loop paused</span>}
    </p>
  );
};

const LiveDuration = ({ endedMillis, since }: { endedMillis: number; since: string }) => {
  const now = useNow(1_000);
  return <>{durationLabel(endedMillis + Math.max(0, now - Date.parse(since)))}</>;
};

/** The Run's Attempt time: the ended Attempts' time, counting on while one runs. */
const RunDuration = ({ duration }: { readonly duration: RunDurationView }) => (
  <span
    title={
      duration.unmeasured === 0
        ? "Total attempt time"
        : `${duration.unmeasured} ${duration.unmeasured === 1 ? "attempt" : "attempts"} not counted, ended before end times were recorded`
    }
  >
    Duration{" "}
    <span className="font-mono text-xs text-foreground tabular-nums">
      {duration.unmeasured > 0 && "at least "}
      {duration.runningSince === null ? (
        durationLabel(duration.endedMillis)
      ) : (
        <LiveDuration endedMillis={duration.endedMillis} since={duration.runningSince} />
      )}
    </span>
  </span>
);

/**
 * Where and how long the Run's Attempts worked, on the line under the Run's
 * facts: the Worker the newest Attempt runs or ran on and the Attempts' total
 * time, and on the Run page the tokens they used. Nothing before an Attempt starts.
 */
export const WorkFacts = ({
  detail,
  showUsage,
  className,
}: {
  readonly detail: Pick<RunDetailView, "run" | "worker" | "duration" | "usage">;
  /** The Run page shows the tokens; the drawer keeps to the Worker and the time. */
  readonly showUsage: boolean;
  readonly className?: string;
}) =>
  detail.worker === null ? null : (
    <p
      className={cn(
        "flex flex-wrap items-baseline gap-x-5 gap-y-1 text-sm text-muted-foreground",
        className,
      )}
    >
      <span>
        Worker <span className="text-foreground">{detail.worker}</span>
      </span>
      <RunDuration duration={detail.duration} />
      {showUsage && detail.usage.sessions.length > 0 && (
        <UsageFact usage={detail.usage} attempts={detail.run.attempts} />
      )}
    </p>
  );
