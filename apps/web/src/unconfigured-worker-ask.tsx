import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { UnconfiguredWorkerNeed } from "@usine/orchestrator/operator";
import { useState } from "react";
import { ErrorAlert } from "@/components/error-alert";
import { Button } from "@/components/ui/button";
import { Item, ItemContent, ItemDescription, ItemFooter, ItemTitle } from "@/components/ui/item";
import { api } from "./api.ts";
import { needCopy } from "./operator-copy.ts";
import { overviewQuery } from "./overview.ts";

/** A Worker that `usine.yaml` no longer declares, whose Attempts' leftovers the operator can discard. */
export const UnconfiguredWorkerAsk = ({ need }: { readonly need: UnconfiguredWorkerNeed }) => {
  const queries = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const discard = useMutation({
    mutationFn: () => api((client) => client.discardLeftovers({ params: { worker: need.worker } })),
    onSuccess: () => queries.invalidateQueries({ queryKey: overviewQuery().queryKey }),
  });
  const copy = needCopy(need);
  return (
    <Item variant="outline" size="sm" className="w-96 shrink-0">
      <ItemContent>
        <ItemTitle>{copy.title}</ItemTitle>
        <ItemDescription>{copy.detail}</ItemDescription>
        {discard.isError && <ErrorAlert message={discard.error.message} />}
      </ItemContent>
      <ItemFooter>
        <Button
          size="sm"
          variant={confirming ? "destructive" : "outline"}
          disabled={discard.isPending}
          onClick={() => (confirming ? discard.mutate() : setConfirming(true))}
        >
          {discard.isPending ? "Discarding…" : confirming ? "Confirm discard" : "Discard leftovers"}
        </Button>
        {confirming && (
          <Button
            size="sm"
            variant="ghost"
            disabled={discard.isPending}
            onClick={() => setConfirming(false)}
          >
            Keep tracking
          </Button>
        )}
      </ItemFooter>
    </Item>
  );
};
