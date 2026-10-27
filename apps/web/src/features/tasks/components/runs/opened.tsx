import type { RunView } from "@usine/orchestrator/operator";
import { dayTimeLabel, timestampLabel } from "~/lib/strings";

type OpenedProps = { readonly run: RunView };

export const Opened = ({ run }: OpenedProps) => (
  <time
    dateTime={run.openedAt}
    title={`Opened ${timestampLabel(run.openedAt)}`}
    className="font-mono text-xs whitespace-nowrap tabular-nums"
  >
    {dayTimeLabel(run.openedAt)}
  </time>
);
