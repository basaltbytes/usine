import type { RunFailureNeed } from "@usine/orchestrator/operator";
import type { ReactNode } from "react";
import { NeedItem } from "~/components/needs-you/need-item";
import { Button } from "~/components/ui/button";
import { DropdownMenuItem } from "~/components/ui/dropdown-menu";
import { isRunOperationRejected, usePendingRunAction, useRunAction } from "~/hooks/runs/actions";
import { useOpenRun } from "~/hooks/use-open-run";
import { useCanOperateRepository } from "~/lib/permissions";
import {
  applyCiLabelsDescription,
  fixRunStatus,
  needCopy,
  needOpenFixRunLabel,
} from "~/lib/needs-you/strings";
import { runActionLabel, runActionProgress } from "~/lib/runs/strings";

type RunFailureAskProps = {
  readonly need: RunFailureNeed;
  readonly dismiss: ReactNode;
};

/**
 * Renders a failed Run; once a CI fix Run takes its work, names that Run, its progress, and opens
 * it. A Run whose CI wait ended because CI didn't finish offers to apply its CI labels; the server
 * refuses while CI on the same head hasn't passed, and the entry shows why.
 */
export const RunFailureAsk = ({ need, dismiss }: RunFailureAskProps) => {
  const openRun = useOpenRun();
  const permitted = useCanOperateRepository(need.repository);
  const action = useRunAction();
  const sent = usePendingRunAction(need.runId);
  const fixRun = need.fixRun;
  const attemptId = need.unfinishedCiAttemptId;
  return (
    <NeedItem
      copy={needCopy(need)}
      loop={need.loop}
      dismiss={dismiss}
      open={() => openRun(need.runId)}
      description={fixRun === null ? null : fixRunStatus(fixRun)}
      error={
        action.error === null || isRunOperationRejected(action.error) ? null : action.error.message
      }
      actions={
        permitted && attemptId !== undefined ? (
          <Button
            variant="outline"
            title={applyCiLabelsDescription}
            disabled={sent !== undefined}
            onClick={() =>
              action.mutate({
                runId: need.runId,
                request: { action: "applyCiLabels", attemptId },
              })
            }
          >
            {sent === "applyCiLabels"
              ? runActionProgress.applyCiLabels
              : runActionLabel.applyCiLabels}
          </Button>
        ) : undefined
      }
      menu={
        fixRun !== null && (
          <DropdownMenuItem onClick={() => openRun(fixRun.runId)}>
            {needOpenFixRunLabel}
          </DropdownMenuItem>
        )
      }
    />
  );
};
