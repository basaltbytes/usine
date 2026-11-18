import type { RunSummaryView } from "@usine/orchestrator/operator";
import { Option } from "effect";
import { useNow } from "~/hooks/use-now";
import { durationLabel } from "~/lib/strings";
import { attemptsDuration } from "~/lib/tasks/model";
import { TextTooltip } from "~/components/text-tooltip";

type DurationProps = { readonly run: RunSummaryView };

export const Duration = ({ run }: DurationProps) => {
  const now = useNow(30_000);
  return Option.match(attemptsDuration(run, now), {
    onNone: () => null,
    onSome: (milliseconds) => (
      <TextTooltip text="Total attempt time">
        <span className="font-mono text-xs tabular-nums">{durationLabel(milliseconds)}</span>
      </TextTooltip>
    ),
  });
};
