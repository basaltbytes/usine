import { WorkerQuotaAsk } from "./worker-quota-ask";
import { itemName } from "~/components/item/mark";
import { usePageCommands } from "~/components/command-palette/context";
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
import { DropdownMenuItem } from "~/components/ui/dropdown-menu";
import { Button } from "~/components/ui/button";
import { itemIdentity, useOverview } from "~/components/item/identity";
import { useOpenRun } from "~/hooks/use-open-run";
import {
  needCopy,
  needKindLabel,
  needSettingsLabel,
  workerAttemptLabel,
  openWorkerLabel,
} from "~/lib/needs-you/strings";
import { runActionLabel, runActionProgress } from "~/lib/runs/strings";
import { isRunOperationRejected, usePendingRunAction, useRunAction } from "~/hooks/runs/actions";
import { CycleBudgetAsk } from "~/components/needs-you/cycle-budget-ask";
import { NeedItem } from "~/components/needs-you/need-item";
import { UnconfiguredWorkerAsk } from "~/components/needs-you/unconfigured-worker-ask";

type ApprovalAskProps = {
  readonly need: ApprovalNeed;
  readonly dismiss: ReactNode;
};

/**
 * Disables the buttons while any screen sends an action on the Run. If the server rejects the action
 * because the Run changed state, shows no error.
 */
const ApprovalAsk = ({ need, dismiss }: ApprovalAskProps) => {
  const openRun = useOpenRun();
  const action = useRunAction();
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const sent = usePendingRunAction(need.runId);
  const overview = useOverview();
  const origin = need.item === null ? undefined : itemIdentity(overview, need.item).origin;
  const copy = needCopy(need);
  const subject = origin === undefined ? need.runId.slice(0, 8) : itemName(origin);
  usePageCommands(
    sent !== undefined || confirmingCancel
      ? []
      : [
          {
            label: `${runActionLabel.approve} · ${need.repository} · ${subject} · ${need.loop}`,
            run: () => action.mutate({ runId: need.runId, request: { action: "approve" } }),
          },
          {
            label: `${runActionLabel.cancel} · ${need.repository} · ${subject} · ${need.loop}`,
            run: () => setConfirmingCancel(true),
          },
        ],
  );
  return (
    <>
      <NeedItem
        copy={copy}
        loop={need.loop}
        heading={need.loop}
        item={origin}
        dismiss={dismiss}
        open={() => openRun(need.runId)}
        error={
          action.error === null || isRunOperationRejected(action.error)
            ? null
            : action.error.message
        }
        actions={
          <Button
            disabled={sent !== undefined}
            onClick={() => action.mutate({ runId: need.runId, request: { action: "approve" } })}
          >
            {sent === "approve" ? runActionProgress.approve : runActionLabel.approve}
          </Button>
        }
        menu={
          <DropdownMenuItem
            variant="destructive"
            disabled={sent !== undefined}
            onClick={() => setConfirmingCancel(true)}
          >
            {sent === "cancel" ? runActionProgress.cancel : runActionLabel.cancel}
          </DropdownMenuItem>
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
};

const NeedEntry = ({ need }: NeedEntryProps) => {
  const openRun = useOpenRun();
  const dismiss = <DismissNeed need={need} action="dismissNeed" />;
  switch (need._tag) {
    case "WebhookSilenceNeed":
    case "PoolLimitNeed": {
      const copy = needCopy(need);
      return <NeedItem copy={copy} heading={copy.title} dismiss={dismiss} />;
    }
    case "UpgradeDrainNeed":
      return (
        <NeedItem
          copy={needCopy(need)}
          dismiss={dismiss}
          actions={
            <Button
              variant="ghost"
              nativeButton={false}
              render={<Link to="/configuration/settings" />}
            >
              {needSettingsLabel}
            </Button>
          }
        />
      );
    case "ApprovalNeed":
      return <ApprovalAsk need={need} dismiss={dismiss} />;
    case "CycleBudgetNeed":
      return <CycleBudgetAsk need={need} dismiss={dismiss} />;
    case "WorkerQuotaNeed":
      return <WorkerQuotaAsk need={need} dismiss={dismiss} />;
    case "WorkerPreflightNeed":
      return (
        <NeedItem
          copy={needCopy(need)}
          heading={`${need.worker} · ${need.message}`}
          dismiss={dismiss}
          actions={
            <Button
              variant="ghost"
              nativeButton={false}
              render={<Link to="/configuration/workers/$worker" params={{ worker: need.worker }} />}
            >
              {openWorkerLabel}
            </Button>
          }
        />
      );
    case "UnconfiguredWorkerNeed":
      return <UnconfiguredWorkerAsk need={need} dismiss={dismiss} />;
    case "UnresponsiveWorkerNeed":
      return (
        <NeedItem
          since={need.lastAnsweredAt}
          copy={needCopy(need)}
          dismiss={dismiss}
          heading={need.worker}
          actions={
            <Button
              variant="ghost"
              nativeButton={false}
              render={<Link to="/configuration/workers/$worker" params={{ worker: need.worker }} />}
            >
              {openWorkerLabel}
            </Button>
          }
          menu={need.attempts.map((attempt) => (
            <DropdownMenuItem key={attempt.attemptId} onClick={() => openRun(attempt.runId)}>
              {workerAttemptLabel(attempt)}
            </DropdownMenuItem>
          ))}
        />
      );
    default: {
      const copy = needCopy(need);
      const runId = copy.runId;
      return (
        <NeedItem
          copy={copy}
          loop={"loop" in need ? need.loop : undefined}
          dismiss={dismiss}
          open={runId === null ? undefined : () => openRun(runId)}
        />
      );
    }
  }
};

type NeedsYouProps = {
  readonly needs: ReadonlyArray<NeedView>;
};

export const NeedsYou = ({ needs }: NeedsYouProps) => {
  const groups = new Map<NeedView["_tag"], Array<NeedView>>();
  for (const need of needs) {
    const entries = groups.get(need._tag);
    if (entries === undefined) groups.set(need._tag, [need]);
    else entries.push(need);
  }
  return (
    <div className="space-y-4">
      {[...groups].map(([kind, entries]) => (
        <section key={kind} aria-label={`${needKindLabel[kind]} (${entries.length})`}>
          <h3 className="flex items-baseline gap-2 px-3 py-2 text-xs font-medium text-foreground dark:text-needs-you">
            {needKindLabel[kind]}
            <span className="tabular-nums">{entries.length}</span>
          </h3>
          <ul className="divide-y divide-border">
            {entries.map((need) => (
              <NeedEntry key={need.id} need={need} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
};
