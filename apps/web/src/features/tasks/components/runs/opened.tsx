import type { RunSummaryView } from "@usine/orchestrator/operator";
import { dayTimeLabel, timestampLabel } from "~/lib/strings";
import { TextTooltip } from "~/components/text-tooltip";

type OpenedProps = { readonly run: RunSummaryView };

export const Opened = ({ run }: OpenedProps) => (
  <TextTooltip text={`Opened ${timestampLabel(run.openedAt)}`}>
    <time dateTime={run.openedAt} className="font-mono text-xs whitespace-nowrap tabular-nums">
      {dayTimeLabel(run.openedAt)}
    </time>
  </TextTooltip>
);
