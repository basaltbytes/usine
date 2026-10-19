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
}: {
  readonly run: Pick<RunView, "loop" | "repository">;
  readonly item: Option.Option<RunItem>;
  /** Renders the title text in the caller's heading element and size. */
  readonly heading: (title: ReactNode) => ReactNode;
}) => (
  <div className="flex min-w-0 items-baseline gap-2.5">
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
  className,
}: {
  readonly run: Pick<
    RunView,
    "state" | "attempts" | "pullRequestUrl" | "loop" | "agent" | "loopPaused"
  >;
  readonly className?: string;
}) => (
  <p
    className={cn(
      "flex flex-wrap items-center gap-x-5 gap-y-1 text-sm text-muted-foreground",
      className,
    )}
  >
    <span className="inline-flex items-center gap-2 font-medium text-foreground">
      <StateMark state={run.state} />
      {runStateLine(run)}
    </span>
    {run.pullRequestUrl === null ? (
      <span>No pull request</span>
    ) : (
      <a
        href={run.pullRequestUrl}
        {...external}
        className="text-primary underline-offset-4 hover:underline"
      >
        Pull request
        {Option.match(pullRequestNumber(run.pullRequestUrl), {
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
