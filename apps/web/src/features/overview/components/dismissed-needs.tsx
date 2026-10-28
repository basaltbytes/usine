import type { NeedView } from "@usine/orchestrator/operator";
import { CaretRightIcon } from "@phosphor-icons/react";
import { DismissNeed } from "~/components/needs-you/dismiss";
import { NeedItem } from "~/components/needs-you/need-item";
import { Button } from "~/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "~/components/ui/collapsible";
import { dismissedAttentionTitle, needCopy } from "~/lib/needs-you/strings";
import { useOpenRun } from "~/hooks/use-open-run";

type DismissedNeedsProps = { readonly needs: ReadonlyArray<NeedView> };

export const DismissedNeeds = ({ needs }: DismissedNeedsProps) => {
  const openRun = useOpenRun();
  if (needs.length === 0) return null;
  return (
    <Collapsible className="mt-3">
      <CollapsibleTrigger
        render={
          <Button
            variant="ghost"
            size="sm"
            className="-mx-2 w-fit gap-1.5 px-2 text-sm font-medium text-muted-foreground hover:text-foreground data-[panel-open]:text-foreground data-[panel-open]:[&>svg]:rotate-90"
          />
        }
      >
        <CaretRightIcon
          aria-hidden="true"
          className="transition-transform duration-(--duration-fast)"
        />
        {dismissedAttentionTitle} ({needs.length})
      </CollapsibleTrigger>
      <CollapsibleContent>
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
      </CollapsibleContent>
    </Collapsible>
  );
};
