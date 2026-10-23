import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { CycleBudgetNeed } from "@usine/orchestrator/operator";
import { Button } from "@/components/ui/button";
import { api } from "../api.ts";
import { needCopy } from "../operator-copy.ts";
import { overviewQuery } from "../overview.ts";
import { NeedItem } from "./need-item.tsx";

/** Renders the cycle budget Ask of an Item; resetting the budget does not create a Run. */
export const CycleBudgetAsk = ({
  need,
  compact,
}: {
  readonly need: CycleBudgetNeed;
  readonly compact: boolean;
}) => {
  const queries = useQueryClient();
  const reset = useMutation({
    mutationFn: () => api((client) => client.resetCycleBudget({ payload: { askId: need.ask.id } })),
    onSuccess: () => queries.invalidateQueries({ queryKey: overviewQuery().queryKey }),
  });
  return (
    <NeedItem
      copy={needCopy(need)}
      compact={compact}
      error={reset.isError ? reset.error.message : null}
      actions={
        <>
          {need.itemUrl !== null && (
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
