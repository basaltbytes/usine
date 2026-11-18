import type { RunSummaryView } from "@usine/orchestrator/operator";
import { Option } from "effect";
import { failureMessage, failureReason } from "~/lib/runs/strings";
import { runFailure } from "~/lib/tasks/model";
import { TextTooltip } from "~/components/text-tooltip";

type FailureLineProps = { readonly run: RunSummaryView };

export const FailureLine = ({ run }: FailureLineProps) =>
  Option.match(runFailure(run), {
    onNone: () => null,
    onSome: (failure) => (
      <TextTooltip text={failureMessage(failure)}>
        <p className="line-clamp-2 text-xs wrap-anywhere">
          <span className="font-medium text-destructive">{failureReason(failure)}</span>{" "}
          <span className="text-muted-foreground">{failureMessage(failure)}</span>
        </p>
      </TextTooltip>
    ),
  });
