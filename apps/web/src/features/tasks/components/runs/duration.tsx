import type { RunView } from "@usine/orchestrator/operator";
import { Option } from "effect";
import { useNow } from "~/hooks/use-now";
import { durationLabel } from "~/lib/strings";
import { attemptsDuration } from "~/lib/tasks/model";

type DurationProps = { readonly run: RunView };

export const Duration = ({ run }: DurationProps) => {
  const now = useNow(30_000);
  return Option.match(attemptsDuration(run, now), {
    onNone: () => null,
    onSome: (milliseconds) => (
      <span className="font-mono text-xs tabular-nums" title="Total attempt time">
        {durationLabel(milliseconds)}
      </span>
    ),
  });
};
