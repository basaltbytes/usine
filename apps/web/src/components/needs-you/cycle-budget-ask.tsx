import type { ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { CycleBudgetNeed } from "@usine/orchestrator/operator";
import { Option } from "effect";
import { taskCard, useOverview } from "~/components/item/identity";
import { Button } from "~/components/ui/button";
import { api } from "~/lib/api";
import { cycleBudgetCounts, needCopy } from "~/lib/needs-you/strings";
import { overviewQuery } from "~/lib/overview";
import { NeedItem } from "~/components/needs-you/need-item";

type CycleBudgetAskProps = {
  readonly need: CycleBudgetNeed;
  readonly dismiss?: ReactNode;
};

/** Renders the cycle budget Ask of an Item; resetting the budget does not create a Run. */
export const CycleBudgetAsk = ({ need, dismiss }: CycleBudgetAskProps) => {
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
    <NeedItem
      copy={Option.match(item, {
        onNone: () => copy,
        onSome: () => ({ ...copy, detail: cycleBudgetCounts(need.ask) }),
      })}
      item={Option.getOrUndefined(item)}
      dismiss={dismiss}
      error={reset.isError ? reset.error.message : null}
      actions={
        <>
          {Option.isNone(item) && need.itemUrl !== null && (
            <Button
              variant="ghost"
              nativeButton={false}
              render={<a href={need.itemUrl} target="_blank" rel="noreferrer" />}
            >
              Open item
            </Button>
          )}
          <Button variant="outline" disabled={reset.isPending} onClick={() => reset.mutate()}>
            {reset.isPending ? "Resetting…" : "Reset cycle budget"}
          </Button>
        </>
      }
    />
  );
};
