import { machineWaitLine } from "~/lib/runs/strings";
import type { RunView } from "@usine/orchestrator/operator";
import { StateMark } from "~/components/status-badge";
import { useNow } from "~/hooks/use-now";
import { runLineSince } from "~/lib/projects/card";
import { elapsedLabel } from "~/lib/strings";
import { runLineTimeTitle } from "~/features/projects/strings";

type RunLineProps = { readonly run: RunView };

export const RunLine = ({ run }: RunLineProps) => {
  const now = useNow(30_000);
  const since = runLineSince(run);
  return (
    <>
      <p className="flex min-w-0 items-center gap-1.5 text-xs whitespace-nowrap text-muted-foreground">
        <StateMark state={run.state} className="mr-0.5 ml-0.75" />
        <span className="truncate text-foreground">{run.loop}</span>
        <span className="shrink-0">{run.state}</span>
        {since !== null && (
          <time
            className="shrink-0 font-mono tabular-nums"
            dateTime={since}
            title={runLineTimeTitle(run.state, since)}
          >
            {elapsedLabel(since, now)}
          </time>
        )}
        <span className="ml-auto truncate pl-2">{run.agent}</span>
      </p>
      {run.machineWait !== null && (
        <p className="text-xs break-words text-muted-foreground">
          {machineWaitLine(run.machineWait)}
        </p>
      )}
    </>
  );
};
