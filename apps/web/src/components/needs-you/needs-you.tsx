import { Link } from "@tanstack/react-router";
import { DismissNeed } from "./dismiss";
import type { ApprovalNeed, NeedView } from "@usine/orchestrator/operator";
import { type ReactNode, useState } from "react";
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
import { itemIdentity, useOverview } from "~/components/item/identity";
import { cn } from "~/lib/utils";
import { useOpenRun } from "~/hooks/use-open-run";
import { needCopy, workerAttemptLabel, openWorkerLabel } from "~/lib/needs-you/strings";
import { runActionLabel, runActionProgress } from "~/lib/runs/strings";
import { isRunOperationRejected, usePendingRunAction, useRunAction } from "~/hooks/runs/actions";
import { CycleBudgetAsk } from "~/components/needs-you/cycle-budget-ask";
import { NeedItem } from "~/components/needs-you/need-item";
import { UnconfiguredWorkerAsk } from "~/components/needs-you/unconfigured-worker-ask";

type ApprovalAskProps = {
  readonly need: ApprovalNeed;
  readonly dismiss: ReactNode;
  readonly compact: boolean;
};

/**
 * Disables the buttons while any screen sends an action on the Run. If the server rejects the action
 * because the Run changed state, shows no error.
 */
const ApprovalAsk = ({ need, compact, dismiss }: ApprovalAskProps) => {
  const openRun = useOpenRun();
  const action = useRunAction();
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const sent = usePendingRunAction(need.runId);
  const overview = useOverview();
  const origin = need.item === null ? undefined : itemIdentity(overview, need.item).origin;
  const copy = needCopy(need);
  return (
    <>
      <NeedItem
        copy={origin === undefined ? copy : { ...copy, detail: origin.title }}
        item={origin}
        compact={compact}
        dismiss={dismiss}
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

type NeedEntryProps = {
  readonly need: NeedView;
  readonly compact: boolean;
};

export const NeedEntry = ({ need, compact }: NeedEntryProps) => {
  const openRun = useOpenRun();
  const dismiss = <DismissNeed need={need} action="dismissNeed" />;
  switch (need._tag) {
    case "ApprovalNeed":
      return <ApprovalAsk need={need} compact={compact} dismiss={dismiss} />;
    case "CycleBudgetNeed":
      return <CycleBudgetAsk need={need} compact={compact} dismiss={dismiss} />;
    case "WorkerPreflightNeed":
      return (
        <NeedItem
          copy={needCopy(need)}
          compact={compact}
          fullDetail
          dismiss={dismiss}
          actions={
            <Button
              variant="ghost"
              render={<Link to="/configuration/workers/$worker" params={{ worker: need.worker }} />}
            >
              {openWorkerLabel}
            </Button>
          }
        />
      );
    case "UnconfiguredWorkerNeed":
      return <UnconfiguredWorkerAsk need={need} compact={compact} dismiss={dismiss} />;
    case "UnresponsiveWorkerNeed":
      return (
        <NeedItem
          copy={needCopy(need)}
          compact={compact}
          fullDetail
          dismiss={dismiss}
          actions={need.attempts.map((attempt) => (
            <Button
              key={attempt.attemptId}
              variant="ghost"
              className="h-auto min-h-7 max-w-full text-left whitespace-normal wrap-anywhere"
              onClick={() => openRun(attempt.runId)}
            >
              {workerAttemptLabel(attempt)}
            </Button>
          ))}
        />
      );
    default: {
      const copy = needCopy(need);
      const runId = copy.runId;
      return (
        <NeedItem
          copy={copy}
          dismiss={dismiss}
          compact={compact}
          open={runId === null ? undefined : () => openRun(runId)}
        />
      );
    }
  }
};

type NeedsYouProps = {
  readonly needs: ReadonlyArray<NeedView>;
  readonly compact?: boolean;
};

/** If there are no entries, renders nothing. `compact` renders one line per entry. */
export const NeedsYou = ({ needs, compact = false }: NeedsYouProps) =>
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
