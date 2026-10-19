import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { UnconfiguredWorkerNeed } from "@usine/orchestrator/operator";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { api } from "../api.ts";
import { needCopy } from "../operator-copy.ts";
import { overviewQuery } from "../overview.ts";
import { NeedItem } from "./need-item.tsx";

/** A Worker that `usine.yaml` no longer declares, whose Attempts' leftovers the operator can discard. */
export const UnconfiguredWorkerAsk = ({ need }: { readonly need: UnconfiguredWorkerNeed }) => {
  const queries = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const discard = useMutation({
    mutationFn: () => api((client) => client.discardLeftovers({ params: { worker: need.worker } })),
    onSuccess: () => queries.invalidateQueries({ queryKey: overviewQuery().queryKey }),
  });
  return (
    <NeedItem
      copy={needCopy(need)}
      error={discard.isError ? discard.error.message : null}
      actions={
        <>
          {confirming && (
            <Button
              variant="ghost"
              disabled={discard.isPending}
              onClick={() => setConfirming(false)}
            >
              Keep tracking
            </Button>
          )}
          <Button
            variant={confirming ? "destructive" : "outline"}
            disabled={discard.isPending}
            onClick={() => (confirming ? discard.mutate() : setConfirming(true))}
          >
            {discard.isPending
              ? "Discarding…"
              : confirming
                ? "Confirm discard"
                : "Discard leftovers"}
          </Button>
        </>
      }
    />
  );
};
