import type { RunFailureNeed } from "@usine/orchestrator/operator";
import type { ReactNode } from "react";
import { NeedItem } from "~/components/needs-you/need-item";
import { DropdownMenuItem } from "~/components/ui/dropdown-menu";
import { useOpenRun } from "~/hooks/use-open-run";
import { fixRunContinues, needCopy, needOpenFixRunLabel } from "~/lib/needs-you/strings";

type RunFailureAskProps = {
  readonly need: RunFailureNeed;
  readonly dismiss: ReactNode;
};

/** Renders a failed Run; once a CI fix Run carries its work, names that Run and opens it. */
export const RunFailureAsk = ({ need, dismiss }: RunFailureAskProps) => {
  const openRun = useOpenRun();
  const fixRunId = need.fixRunId;
  return (
    <NeedItem
      copy={needCopy(need)}
      loop={need.loop}
      dismiss={dismiss}
      open={() => openRun(need.runId)}
      description={fixRunId === null ? null : fixRunContinues(fixRunId)}
      menu={
        fixRunId !== null && (
          <DropdownMenuItem onClick={() => openRun(fixRunId)}>
            {needOpenFixRunLabel}
          </DropdownMenuItem>
        )
      }
    />
  );
};
