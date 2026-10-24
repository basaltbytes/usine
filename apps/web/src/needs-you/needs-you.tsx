import type { ApprovalNeed, NeedView } from "@usine/orchestrator/operator";
import { useState } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useOpenRun } from "../open-run.ts";
import { needCopy, runActionLabel, runActionProgress } from "../operator-copy.ts";
import { isRunOperationRejected, usePendingRunAction, useRunAction } from "../run-actions.ts";
import { CycleBudgetAsk } from "./cycle-budget-ask.tsx";
import { NeedItem } from "./need-item.tsx";
import { UnconfiguredWorkerAsk } from "./unconfigured-worker-ask.tsx";

/**
 * Disables the buttons while any screen sends an action on the Run. If the server rejects the action
 * because the Run changed state, shows no error.
 */
const ApprovalAsk = ({
  need,
  compact,
}: {
  readonly need: ApprovalNeed;
  readonly compact: boolean;
}) => {
  const openRun = useOpenRun();
  const action = useRunAction();
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const sent = usePendingRunAction(need.runId);
  return (
    <>
      <NeedItem
        copy={needCopy(need)}
        compact={compact}
        open={() => openRun(need.runId)}
        error={
          action.error === null || isRunOperationRejected(action.error)
            ? null
            : action.error.message
        }
        actions={
          <>
            <Button
              disabled={sent !== undefined}
              onClick={() => action.mutate({ runId: need.runId, request: { action: "approve" } })}
            >
              {sent === "approve" ? runActionProgress.approve : runActionLabel.approve}
            </Button>
            <Button
              variant="ghost"
              disabled={sent !== undefined}
              onClick={() => setConfirmingCancel(true)}
            >
              {sent === "cancel" ? runActionProgress.cancel : runActionLabel.cancel}
            </Button>
          </>
        }
      />
      <AlertDialog open={confirmingCancel} onOpenChange={setConfirmingCancel}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancel {need.loop}?</AlertDialogTitle>
            <AlertDialogDescription>
              The run on {need.repository} never starts.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{runActionLabel.keepRunning}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                setConfirmingCancel(false);
                action.mutate({ runId: need.runId, request: { action: "cancel" } });
              }}
            >
              {runActionLabel.confirmCancel}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
};

export const NeedEntry = ({
  need,
  compact,
}: {
  readonly need: NeedView;
  readonly compact: boolean;
}) => {
  const openRun = useOpenRun();
  switch (need._tag) {
    case "ApprovalNeed":
      return <ApprovalAsk need={need} compact={compact} />;
    case "CycleBudgetNeed":
      return <CycleBudgetAsk need={need} compact={compact} />;
    case "UnconfiguredWorkerNeed":
      return <UnconfiguredWorkerAsk need={need} compact={compact} />;
    default: {
      const copy = needCopy(need);
      const runId = copy.runId;
      return (
        <NeedItem
          copy={copy}
          compact={compact}
          open={runId === null ? undefined : () => openRun(runId)}
        />
      );
    }
  }
};

/** If there are no entries, renders nothing. `compact` renders one line per entry. */
export const NeedsYou = ({
  needs,
  compact = false,
}: {
  readonly needs: ReadonlyArray<NeedView>;
  readonly compact?: boolean;
}) =>
  needs.length === 0 ? null : (
    <section aria-label="Needs attention" className={cn("px-4 md:px-5", compact ? "pt-3" : "pt-4")}>
      <ul
        className={cn(
          "grid max-w-7xl grid-cols-1 items-start",
          compact ? "gap-1.5" : "gap-2.5 lg:grid-cols-2",
        )}
      >
        {needs.map((need) => (
          <NeedEntry key={need.id} need={need} compact={compact} />
        ))}
      </ul>
    </section>
  );
