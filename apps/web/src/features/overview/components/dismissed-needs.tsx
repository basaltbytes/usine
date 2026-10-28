import type { NeedView } from "@usine/orchestrator/operator";
import { DismissNeed } from "~/components/needs-you/dismiss";
import { NeedItem } from "~/components/needs-you/need-item";
import { dismissedAttentionTitle, needCopy } from "~/lib/needs-you/strings";
import { useOpenRun } from "~/hooks/use-open-run";

type DismissedNeedsProps = { readonly needs: ReadonlyArray<NeedView> };

export const DismissedNeeds = ({ needs }: DismissedNeedsProps) => {
  const openRun = useOpenRun();
  if (needs.length === 0) return null;
  return (
    <details className="mt-3">
      <summary className="cursor-pointer rounded-md text-sm text-muted-foreground focus-visible:outline-2 focus-visible:outline-ring">
        {dismissedAttentionTitle} ({needs.length})
      </summary>
      <ul className="mt-2.5 grid grid-cols-1 items-start gap-2.5 lg:grid-cols-2">
        {needs.map((need) => {
          const copy = needCopy(need);
          const runId = copy.runId;
          return (
            <NeedItem
              key={need.id}
              copy={copy}
              open={runId === null ? undefined : () => openRun(runId)}
              actions={<DismissNeed need={need} action="undoDismissNeed" />}
            />
          );
        })}
      </ul>
    </details>
  );
};
