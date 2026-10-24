import type { SettledItemState } from "@usine/config/board";
import type { RunDetailView, RunDurationView, RunView } from "@usine/orchestrator/operator";
import { Option } from "effect";
import type { ReactNode } from "react";
import { StateMark } from "@/components/status-badge";
import { useNow } from "@/hooks/use-now";
import { cn } from "@/lib/utils";
import { durationLabel, runStateLine, settledItemLabel } from "../operator-copy.ts";
import { pullRequestNumber, type RunItem } from "./item.ts";
import { UsageFact } from "./usage.tsx";

const external = { target: "_blank", rel: "noreferrer" } as const;

/** If the Run has no Item or its title is unknown, renders the Loop name. */
export const RunTitle = ({
  run,
  item,
  heading,
  shared,
}: {
  readonly run: Pick<RunView, "loop" | "repository">;
  readonly item: Option.Option<RunItem>;
  /** Wraps the title in the caller's heading element. */
  readonly heading: (title: ReactNode) => ReactNode;
  /** Whether the title gets the drawer-to-page view transition name; only one visible title can have it. */
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

export const RunFacts = ({
  run,
  item,
  settledItemState = null,
  shared,
  className,
}: {
  readonly run: Pick<
    RunView,
    "state" | "attempts" | "pullRequestUrl" | "loop" | "agent" | "loopPaused"
  >;
  /** If the Run opened no pull request and the Item is one, the Item is shown as the pull request. */
  readonly item: Option.Option<RunItem>;
  /** The Item's state if it's closed or merged, shown for a failed Run. */
  readonly settledItemState?: SettledItemState | null;
  /** Whether the state gets the drawer-to-page view transition name. */
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
      {run.state === "Failed" && settledItemState !== null && (
        <span>{settledItemLabel(settledItemState)}</span>
      )}
    </p>
  );
};

const LiveDuration = ({ endedMillis, since }: { endedMillis: number; since: string }) => {
  const now = useNow(1_000);
  return <>{durationLabel(endedMillis + Math.max(0, now - Date.parse(since)))}</>;
};

/** Renders the total Attempt time, which keeps counting while an Attempt runs. */
const RunDuration = ({ duration }: { readonly duration: RunDurationView }) => (
  <span
    title={
      duration.unmeasured === 0
        ? "Total attempt time"
        : `${duration.unmeasured} ${duration.unmeasured === 1 ? "attempt" : "attempts"} not counted: no recorded end time`
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

/** Renders the newest Attempt's Worker and the total Attempt time, or nothing before an Attempt starts. */
export const WorkFacts = ({
  detail,
  showUsage,
  className,
}: {
  readonly detail: Pick<RunDetailView, "run" | "worker" | "duration" | "usage">;
  /** Whether to show token usage; `true` on the Run page, `false` in the drawer. */
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
