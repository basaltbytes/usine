import { AttemptTask } from "@usine/core/attempt";
import type { RunId } from "@usine/core/run";
import { EditAndRetry as Amendment, type RunView } from "@usine/orchestrator/operator";
import { useState } from "react";
import { ErrorAlert } from "@/components/error-alert";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { runActionLabel, runAgainBlocked } from "../operator-copy.ts";
import { type RunActionRequest, useRunAction, useRunAgain } from "../run-actions.ts";
import type { EditIntent } from "./edit-and-retry.tsx";

/**
 * The Run actions that apply now: Approve, Retry, Edit and retry, Run again, Edit and run
 * again, Mark resolved or Mark answered, and Cancel Run behind a confirmation. Nothing
 * renders when none applies.
 */
export const RunActions = ({
  run,
  onEdit,
  openRun,
  className,
}: {
  readonly run: RunView;
  /** Opens the task and Agent editor for a retry or a run again; offered only while that applies. */
  readonly onEdit: (intent: EditIntent) => void;
  /** Shows the Run that running this one again opened. */
  readonly openRun: (runId: RunId) => void;
  readonly className?: string;
}) => {
  const mutation = useRunAction();
  const again = useRunAgain(run.id);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const busy = mutation.isPending || again.isPending;
  const act = (request: RunActionRequest) =>
    mutation.mutate({ runId: run.id, request }, { onSuccess: () => setConfirmCancel(false) });
  const runAgain = () =>
    again.mutate(new Amendment({ task: AttemptTask.make(run.task), agent: run.agent }), {
      onSuccess: (result) => {
        if (result._tag === "Claimed") openRun(result.runId);
      },
    });
  const latest = run.attempts.at(-1);
  const question =
    latest?.outcome?._tag === "Failed" && latest.outcome.failure._tag === "QuestionFailure";
  if (
    !run.canApprove &&
    !run.canRetry &&
    !run.canRunAgain &&
    !run.canCancel &&
    !run.canResolveFailure
  )
    return null;
  return (
    <div className={cn("space-y-2", className)}>
      <div role="group" aria-label="Run actions" className="flex flex-wrap items-center gap-2">
        {run.canApprove && (
          <Button disabled={busy} onClick={() => act({ action: "approve" })}>
            {runActionLabel.approve}
          </Button>
        )}
        {run.canRetry && (
          <Button disabled={busy} onClick={() => act({ action: "retry" })}>
            {runActionLabel.retry}
          </Button>
        )}
        {run.canRetry && (
          <Button variant="outline" disabled={busy} onClick={() => onEdit("retry")}>
            Edit and retry
          </Button>
        )}
        {run.canRunAgain && (
          <Button disabled={busy} onClick={runAgain}>
            {runActionLabel.runAgain}
          </Button>
        )}
        {run.canRunAgain && (
          <Button variant="outline" disabled={busy} onClick={() => onEdit("runAgain")}>
            Edit and run again
          </Button>
        )}
        {run.canResolveFailure && latest !== undefined && (
          <Button
            variant="ghost"
            disabled={busy}
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
                disabled={busy}
                onClick={() => act({ action: "cancel" })}
              >
                {runActionLabel.confirmCancel}
              </Button>
              <Button variant="ghost" disabled={busy} onClick={() => setConfirmCancel(false)}>
                {runActionLabel.keepRunning}
              </Button>
            </>
          ) : (
            <Button variant="ghost" disabled={busy} onClick={() => setConfirmCancel(true)}>
              {runActionLabel.cancel}
            </Button>
          ))}
      </div>
      {again.data?._tag === "CycleBlocked" && (
        <p role="status" className="text-xs text-needs-you">
          {runAgainBlocked}
        </p>
      )}
      {mutation.isError && <ErrorAlert message={mutation.error.message} />}
      {again.isError && <ErrorAlert message={again.error.message} />}
    </div>
  );
};
