import type { RunView } from "@usine/orchestrator/operator";
import { useState } from "react";
import { ErrorAlert } from "@/components/error-alert";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { runActionLabel } from "../operator-copy.ts";
import { type RunActionRequest, useRunAction } from "../run-actions.ts";

/**
 * The Run actions that apply now: Approve, Retry, Edit and retry, Mark resolved or Mark
 * answered, and Cancel Run behind a confirmation. Nothing renders when none applies.
 */
export const RunActions = ({
  run,
  onEdit,
  className,
}: {
  readonly run: RunView;
  /** Opens the Edit and retry form; only offered while the Run can be retried. */
  readonly onEdit: () => void;
  readonly className?: string;
}) => {
  const mutation = useRunAction();
  const [confirmCancel, setConfirmCancel] = useState(false);
  const act = (request: RunActionRequest) =>
    mutation.mutate({ runId: run.id, request }, { onSuccess: () => setConfirmCancel(false) });
  const latest = run.attempts.at(-1);
  const question =
    latest?.outcome?._tag === "Failed" && latest.outcome.failure._tag === "QuestionFailure";
  if (!run.canApprove && !run.canRetry && !run.canCancel && !run.canResolveFailure) return null;
  return (
    <div className={cn("space-y-2", className)}>
      <div role="group" aria-label="Run actions" className="flex flex-wrap items-center gap-2">
        {run.canApprove && (
          <Button disabled={mutation.isPending} onClick={() => act({ action: "approve" })}>
            {runActionLabel.approve}
          </Button>
        )}
        {run.canRetry && (
          <Button disabled={mutation.isPending} onClick={() => act({ action: "retry" })}>
            {runActionLabel.retry}
          </Button>
        )}
        {run.canRetry && (
          <Button variant="outline" disabled={mutation.isPending} onClick={onEdit}>
            Edit and retry
          </Button>
        )}
        {run.canResolveFailure && latest !== undefined && (
          <Button
            variant="ghost"
            disabled={mutation.isPending}
            onClick={() => act({ action: "resolveFailure", attemptId: latest.id })}
          >
            {question ? "Mark answered" : "Mark resolved"}
          </Button>
        )}
        {run.canCancel &&
          (confirmCancel ? (
            <>
              <Button
                variant="destructive"
                disabled={mutation.isPending}
                onClick={() => act({ action: "cancel" })}
              >
                {runActionLabel.confirmCancel}
              </Button>
              <Button
                variant="ghost"
                disabled={mutation.isPending}
                onClick={() => setConfirmCancel(false)}
              >
                {runActionLabel.keepRunning}
              </Button>
            </>
          ) : (
            <Button
              variant="ghost"
              disabled={mutation.isPending}
              onClick={() => setConfirmCancel(true)}
            >
              {runActionLabel.cancel}
            </Button>
          ))}
      </div>
      {mutation.isError && <ErrorAlert message={mutation.error.message} />}
    </div>
  );
};
