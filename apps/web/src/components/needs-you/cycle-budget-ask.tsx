import { type ReactNode, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { CycleBudgetNeed } from "@usine/orchestrator/operator";
import { Option } from "effect";
import { taskCard, useOverview } from "~/components/item/identity";
import { DropdownMenuItem, DropdownMenuLinkItem } from "~/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { Button } from "~/components/ui/button";
import { api } from "~/lib/api";
import {
  cycleBudgetCounts,
  needCopy,
  needDetailsLabel,
  needOpenItemLabel,
} from "~/lib/needs-you/strings";
import { overviewQuery } from "~/lib/overview";
import { NeedItem } from "~/components/needs-you/need-item";

type CycleBudgetAskProps = {
  readonly need: CycleBudgetNeed;
  readonly dismiss?: ReactNode;
};

/** Renders the cycle budget Ask of an Item; resetting the budget does not create a Run. */
export const CycleBudgetAsk = ({ need, dismiss }: CycleBudgetAskProps) => {
  const [showDetails, setShowDetails] = useState(false);
  const queries = useQueryClient();
  const reset = useMutation({
    mutationFn: () => api((client) => client.resetCycleBudget({ payload: { askId: need.ask.id } })),
    onSuccess: () => queries.invalidateQueries({ queryKey: overviewQuery().queryKey }),
  });
  const item = Option.flatMap(taskCard(useOverview(), need.ask.itemKey), ({ items }) =>
    Option.fromNullishOr(items.find(({ itemKey }) => itemKey === need.ask.itemKey)),
  );
  const copy = needCopy(need);
  return (
    <>
      <NeedItem
        copy={Option.match(item, {
          onNone: () => copy,
          onSome: () => ({ ...copy, detail: cycleBudgetCounts(need.ask) }),
        })}
        item={Option.getOrUndefined(item)}
        loop={need.ask.loop}
        dismiss={dismiss}
        error={reset.isError ? reset.error.message : null}
        heading={need.itemLabel}
        menu={
          <>
            <DropdownMenuItem onClick={() => setShowDetails(true)}>
              {needDetailsLabel}
            </DropdownMenuItem>
            {Option.isNone(item) && need.itemUrl !== null && (
              <DropdownMenuLinkItem href={need.itemUrl} target="_blank" rel="noreferrer">
                {needOpenItemLabel}
              </DropdownMenuLinkItem>
            )}
          </>
        }
        actions={
          <Button variant="outline" disabled={reset.isPending} onClick={() => reset.mutate()}>
            {reset.isPending ? "Resetting…" : "Reset cycle budget"}
          </Button>
        }
      />
      <Dialog open={showDetails} onOpenChange={setShowDetails}>
        <DialogContent className="max-h-[70dvh] overflow-y-auto wrap-anywhere">
          <DialogHeader>
            <DialogTitle>{copy.title}</DialogTitle>
            <DialogDescription>{copy.detail}</DialogDescription>
          </DialogHeader>
        </DialogContent>
      </Dialog>
    </>
  );
};
