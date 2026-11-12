import type { RunFailureNeed } from "@usine/orchestrator/operator";
import type { ReactNode } from "react";
import { NeedItem } from "~/components/needs-you/need-item";
import { DropdownMenuItem } from "~/components/ui/dropdown-menu";
import { useOpenRun } from "~/hooks/use-open-run";
import { fixRunStatus, needCopy, needOpenFixRunLabel } from "~/lib/needs-you/strings";

type RunFailureAskProps = {
  readonly need: RunFailureNeed;
  readonly dismiss: ReactNode;
};

/** Renders a failed Run; once a CI fix Run takes its work, names that Run, its progress, and opens it. */
export const RunFailureAsk = ({ need, dismiss }: RunFailureAskProps) => {
  const openRun = useOpenRun();
  const fixRun = need.fixRun;
  return (
    <NeedItem
      copy={needCopy(need)}
      loop={need.loop}
      dismiss={dismiss}
      open={() => openRun(need.runId)}
      description={fixRun === null ? null : fixRunStatus(fixRun)}
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
