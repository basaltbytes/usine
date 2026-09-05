import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { CycleBudgetNeed } from "@usine/orchestrator/operator";
import { ErrorAlert } from "@/components/error-alert";
import { Button } from "@/components/ui/button";
import { Item, ItemContent, ItemDescription, ItemFooter, ItemTitle } from "@/components/ui/item";
import { api } from "./api.ts";
import { needCopy } from "./operator-copy.ts";
import { overviewQuery } from "./overview.ts";

/** An Item-level Ask that remains actionable without creating a Run. */
export const CycleBudgetAsk = ({ need }: { readonly need: CycleBudgetNeed }) => {
  const queries = useQueryClient();
  const reset = useMutation({
    mutationFn: () => api((client) => client.resetCycleBudget({ payload: { askId: need.ask.id } })),
    onSuccess: () => queries.invalidateQueries({ queryKey: overviewQuery().queryKey }),
  });
  const copy = needCopy(need);
  return (
    <Item variant="outline" size="sm" className="w-96 shrink-0">
      <ItemContent>
        <ItemTitle>{copy.title}</ItemTitle>
        <ItemDescription>{copy.detail}</ItemDescription>
        {reset.isError && <ErrorAlert message={reset.error.message} />}
      </ItemContent>
      <ItemFooter>
        {need.itemUrl !== null && (
          <a href={need.itemUrl} target="_blank" rel="noreferrer" className="text-sm underline">
            Open Item
          </a>
        )}
        <Button
          size="sm"
          variant="outline"
          disabled={reset.isPending}
          onClick={() => reset.mutate()}
        >
          {reset.isPending ? "Resetting…" : "Reset cycle budget"}
        </Button>
      </ItemFooter>
    </Item>
  );
};
