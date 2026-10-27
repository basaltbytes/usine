import type { RunView } from "@usine/orchestrator/operator";
import { Option } from "effect";
import { type ItemRef } from "~/components/item/mark";
import { Duration } from "~/features/tasks/components/runs/duration";
import { Opened } from "~/features/tasks/components/runs/opened";
import { PullRequest } from "~/features/tasks/components/runs/pull-request";

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

type FoldedFactsProps = {
  readonly run: RunView;
  readonly pullRequest: Option.Option<ItemRef>;
};

/** Renders the facts that have no column below the `xl` breakpoint. */
export const FoldedFacts = ({ run, pullRequest }: FoldedFactsProps) => (
  <p className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-xs text-muted-foreground xl:hidden">
    <span className="font-medium text-foreground sm:hidden">{run.state}</span>
    <span>{run.agent}</span>
    <span>{plural(run.attempts.length, "attempt")}</span>
    <Duration run={run} />
    <Opened run={run} />
    <PullRequest pullRequest={pullRequest} />
  </p>
);
