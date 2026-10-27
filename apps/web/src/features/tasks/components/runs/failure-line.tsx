import type { RunView } from "@usine/orchestrator/operator";
import { Option } from "effect";
import { failureMessage, failureReason } from "~/lib/runs/strings";
import { runFailure } from "~/lib/tasks/model";

type FailureLineProps = { readonly run: RunView };

export const FailureLine = ({ run }: FailureLineProps) =>
  Option.match(runFailure(run), {
    onNone: () => null,
    onSome: (failure) => (
      <p className="line-clamp-2 text-xs wrap-anywhere" title={failureMessage(failure)}>
        <span className="font-medium text-destructive">{failureReason(failure)}</span>{" "}
        <span className="text-muted-foreground">{failureMessage(failure)}</span>
      </p>
    ),
  });
