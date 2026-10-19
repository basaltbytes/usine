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
import { useOpenRun } from "../open-run.ts";
import { needCopy, runActionLabel, runActionProgress } from "../operator-copy.ts";
import { useRunAction } from "../run-actions.ts";
import { CycleBudgetAsk } from "./cycle-budget-ask.tsx";
import { NeedItem } from "./need-item.tsx";
import { UnconfiguredWorkerAsk } from "./unconfigured-worker-ask.tsx";

/** A Run waiting for approval, approved or canceled from Needs you; the entry opens its drawer. */
const ApprovalAsk = ({ need }: { readonly need: ApprovalNeed }) => {
  const openRun = useOpenRun();
  const action = useRunAction();
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const sent = action.isPending ? action.variables?.request.action : undefined;
  return (
    <>
      <NeedItem
        copy={needCopy(need)}
        open={() => openRun(need.runId)}
        error={action.error?.message ?? null}
        actions={
          <>
            <Button
              disabled={action.isPending}
              onClick={() => action.mutate({ runId: need.runId, request: { action: "approve" } })}
            >
              {sent === "approve" ? runActionProgress.approve : runActionLabel.approve}
            </Button>
            <Button
              variant="ghost"
              disabled={action.isPending}
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
              The Run on {need.repository} stops before it starts.
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

const NeedEntry = ({ need }: { readonly need: NeedView }) => {
  const openRun = useOpenRun();
  switch (need._tag) {
    case "ApprovalNeed":
      return <ApprovalAsk need={need} />;
    case "CycleBudgetNeed":
      return <CycleBudgetAsk need={need} />;
    case "UnconfiguredWorkerNeed":
      return <UnconfiguredWorkerAsk need={need} />;
    default: {
      const copy = needCopy(need);
      const runId = copy.runId;
      return <NeedItem copy={copy} open={runId === null ? undefined : () => openRun(runId)} />;
    }
  }
};

/** Everything that waits on the operator across Projects, each entry with its own actions. Renders
 * nothing when nothing does. */
export const NeedsYou = ({ needs }: { readonly needs: ReadonlyArray<NeedView> }) =>
  needs.length === 0 ? null : (
    <section aria-label="Items needing intervention" className="px-4 pt-4 md:px-5">
      <ul className="grid max-w-7xl grid-cols-1 items-start gap-2.5 lg:grid-cols-2">
        {needs.map((need) => (
          <NeedEntry key={need.id} need={need} />
        ))}
      </ul>
    </section>
  );
