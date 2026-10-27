import { DotsThreeIcon } from "@phosphor-icons/react";
import type { RunId } from "@usine/core/run";
import type { RunView } from "@usine/orchestrator/operator";
import { type ReactNode, useState } from "react";
import { type EditIntent } from "~/components/runs/intervention/edit-and-retry";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog";
import { Button } from "~/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import {
  type RunActionRequest,
  unchangedRunAgain,
  useRunAction,
  useRunAgain,
} from "~/hooks/runs/actions";
import { dayTimeLabel } from "~/lib/strings";
import {
  retryDescription,
  runActionLabel,
  runActionProgress,
  runAgainBlocked,
  runAgainProgress,
} from "~/lib/runs/strings";

/** Returns the action shown as a button next to the menu, or `null` if none. */
const primaryAction = (run: RunView): "approve" | "retry" | null =>
  run.canApprove ? "approve" : run.canRetry && run.canResolveFailure ? "retry" : null;

interface MenuEntry {
  readonly label: string;
  readonly description?: string;
  readonly destructive?: boolean;
  readonly select: () => void;
}

type RowActionsProps = {
  readonly run: RunView;
  readonly onEdit: (intent: EditIntent) => void;
  readonly openRun: (runId: RunId) => void;
  readonly status: (message: ReactNode) => void;
};

/** While an action is pending, shows its progress instead of the actions. */
export const RowActions = ({ run, onEdit, openRun, status }: RowActionsProps) => {
  const action = useRunAction();
  const again = useRunAgain();
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  if (action.isPending && action.variables !== undefined)
    return (
      <span role="status" className="text-xs text-muted-foreground">
        {runActionProgress[action.variables.request.action]}
      </span>
    );
  if (again.isPending)
    return (
      <span role="status" className="text-xs text-muted-foreground">
        {runAgainProgress}
      </span>
    );
  const act = (request: RunActionRequest) =>
    action.mutate(
      { runId: run.id, request },
      {
        onSuccess: () => status(null),
        onError: (error) => status(<span className="text-destructive">{error.message}</span>),
      },
    );
  const runAgain = () =>
    again.mutate(unchangedRunAgain(run), {
      onSuccess: (result) => {
        if (result._tag === "Claimed") {
          status(null);
          openRun(result.runId);
        } else status(<span className="text-needs-you">{runAgainBlocked}</span>);
      },
      onError: (error) => status(<span className="text-destructive">{error.message}</span>),
    });
  const latest = run.attempts.at(-1);
  const primary = primaryAction(run);
  const question =
    latest?.outcome?._tag === "Failed" && latest.outcome.failure._tag === "QuestionFailure";
  const entries: Array<MenuEntry> = [];
  if (run.canApprove && primary !== "approve")
    entries.push({ label: runActionLabel.approve, select: () => act({ action: "approve" }) });
  if (run.canRetry && primary !== "retry")
    entries.push({
      label: runActionLabel.retry,
      description: retryDescription(run.agentBrain),
      select: () => act({ action: "retry" }),
    });
  if (run.canRetry) entries.push({ label: "Edit and retry", select: () => onEdit("retry") });
  if (run.canRunAgain) {
    entries.push({ label: runActionLabel.runAgain, select: runAgain });
    entries.push({ label: "Edit and run again", select: () => onEdit("runAgain") });
  }
  if (run.canResolveFailure && latest !== undefined)
    entries.push({
      label: question ? "Mark answered" : "Mark resolved",
      select: () => act({ action: "resolveFailure", attemptId: latest.id }),
    });
  if (run.canCancel)
    entries.push({
      label: runActionLabel.cancel,
      destructive: true,
      select: () => setConfirmingCancel(true),
    });
  return (
    <div className="relative z-10 flex items-center justify-end gap-1">
      {primary !== null && (
        <Button
          variant="outline"
          size="sm"
          title={primary === "retry" ? retryDescription(run.agentBrain) : undefined}
          onClick={() => act({ action: primary })}
        >
          {runActionLabel[primary]}
        </Button>
      )}
      {entries.length > 0 && (
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                className="text-muted-foreground hover:text-foreground aria-expanded:text-foreground"
              />
            }
            aria-label={`Actions for the ${run.loop} run opened ${dayTimeLabel(run.openedAt)}`}
          >
            <DotsThreeIcon weight="bold" className="size-4" aria-hidden="true" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-auto min-w-44">
            <DropdownMenuGroup>
              {entries.map(({ label, description, destructive, select }) => (
                <DropdownMenuItem
                  key={label}
                  title={description}
                  variant={destructive === true ? "destructive" : "default"}
                  onClick={select}
                >
                  {label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      {run.canCancel && (
        <AlertDialog open={confirmingCancel} onOpenChange={setConfirmingCancel}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Cancel {run.loop}?</AlertDialogTitle>
              <AlertDialogDescription>
                The run stops, including any attempt in progress.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{runActionLabel.keepRunning}</AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                onClick={() => {
                  setConfirmingCancel(false);
                  act({ action: "cancel" });
                }}
              >
                {runActionLabel.confirmCancel}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </div>
  );
};
