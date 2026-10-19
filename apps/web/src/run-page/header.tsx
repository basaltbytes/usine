import type { RunView } from "@usine/orchestrator/operator";
import { Option } from "effect";
import type { ReactNode } from "react";
import { StateMark } from "@/components/status-badge";
import { cn } from "@/lib/utils";
import { runStateLine } from "../operator-copy.ts";
import { pullRequestNumber, type RunItem } from "./item.ts";

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
