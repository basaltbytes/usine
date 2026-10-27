import { DotsThreeIcon } from "@phosphor-icons/react";
import type { RunId } from "@usine/core/run";
import type { RunView } from "@usine/orchestrator/operator";
import { Match } from "effect";
import { useState } from "react";
import { ErrorAlert } from "~/components/error-alert";
import { Button } from "~/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { cn } from "~/lib/utils";
import { runActionLabel, runAgainBlocked } from "~/lib/runs/strings";
import {
  type RunActionRequest,
  unchangedRunAgain,
  useRunAction,
  useRunAgain,
} from "~/hooks/runs/actions";
import { actionLabel, actionPlan, type RunAction } from "~/lib/runs/intervention/action-plan";
import type { EditIntent } from "~/components/runs/intervention/edit-and-retry";

type ContextualActionsProps = {
  readonly run: RunView;
  /** Opens the task and Agent editor for a retry or a run again. */
  readonly onEdit: (intent: EditIntent) => void;
  /** Opens the Run that Run again created. */
  readonly openRun: (runId: RunId) => void;
  readonly className?: string;
};

/** Renders the Run's primary and secondary actions as buttons and the rest in a menu. If no action applies, renders nothing. */
export const ContextualActions = ({ run, onEdit, openRun, className }: ContextualActionsProps) => {
  const mutation = useRunAction();
  const again = useRunAgain();
  const [confirmCancel, setConfirmCancel] = useState(false);
  const busy = mutation.isPending || again.isPending;
  const act = (request: RunActionRequest) =>
    mutation.mutate({ runId: run.id, request }, { onSuccess: () => setConfirmCancel(false) });
  const select = (action: RunAction) =>
    Match.valueTags(action, {
      Approve: () => act({ action: "approve" }),
      Retry: () => act({ action: "retry" }),
      EditRetry: () => onEdit("retry"),
      RunAgain: () =>
        again.mutate(unchangedRunAgain(run), {
          onSuccess: (result) => {
            if (result._tag === "Claimed") openRun(result.runId);
          },
        }),
      EditRunAgain: () => onEdit("runAgain"),
      Resolve: ({ attemptId }) => act({ action: "resolveFailure", attemptId }),
      Cancel: () => setConfirmCancel(true),
    });
  const { primary, secondary, more } = actionPlan(run);
  if (primary === null && secondary === null && more.length === 0) return null;
  return (
    <div className={cn("space-y-2", className)}>
      <div role="group" aria-label="Run actions" className="flex flex-wrap items-center gap-2">
        {confirmCancel ? (
          <>
            <Button variant="destructive" disabled={busy} onClick={() => act({ action: "cancel" })}>
              {runActionLabel.confirmCancel}
            </Button>
            <Button variant="ghost" disabled={busy} onClick={() => setConfirmCancel(false)}>
              {runActionLabel.keepRunning}
            </Button>
          </>
        ) : (
          <>
            {primary !== null && (
              <Button disabled={busy} onClick={() => select(primary)}>
                {actionLabel(primary)}
              </Button>
            )}
            {secondary !== null && (
              <Button
                variant={secondary._tag === "Cancel" ? "ghost" : "outline"}
                disabled={busy}
                onClick={() => select(secondary)}
              >
                {actionLabel(secondary)}
              </Button>
            )}
            {more.length > 0 && (
              <DropdownMenu>
                <DropdownMenuTrigger
                  disabled={busy}
                  render={
                    <Button
                      variant="ghost"
                      size="icon"
                      className="text-muted-foreground hover:text-foreground aria-expanded:text-foreground"
                    />
                  }
                  aria-label="More actions"
                >
                  <DotsThreeIcon weight="bold" className="size-4" aria-hidden="true" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-auto min-w-44">
                  <DropdownMenuGroup>
                    {more.map((action) => (
                      <DropdownMenuItem
                        key={action._tag}
                        variant={action._tag === "Cancel" ? "destructive" : "default"}
                        onClick={() => select(action)}
                      >
                        {actionLabel(action)}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </>
        )}
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
