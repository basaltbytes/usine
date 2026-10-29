import type { ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { UnconfiguredWorkerNeed } from "@usine/orchestrator/operator";
import { useState } from "react";
import { DropdownMenuItem } from "~/components/ui/dropdown-menu";
import { Button } from "~/components/ui/button";
import { api } from "~/lib/api";
import { needCopy } from "~/lib/needs-you/strings";
import { overviewQuery } from "~/lib/overview";
import { NeedItem } from "~/components/needs-you/need-item";

type DiscardLeftoversAskProps = {
  readonly need: UnconfiguredWorkerNeed;
  readonly dismiss?: ReactNode;
};

/** Discards leftovers after a confirmation; a rejection, such as for a Worker declared again since
 * the overview loaded, is shown under the entry. */
const DiscardLeftoversAsk = ({ need, dismiss }: DiscardLeftoversAskProps) => {
  const queries = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const discard = useMutation({
    mutationFn: () => api((client) => client.discardLeftovers({ params: { worker: need.worker } })),
    onSuccess: () => queries.invalidateQueries({ queryKey: overviewQuery().queryKey }),
  });
  return (
    <NeedItem
      copy={needCopy(need)}
      heading={need.worker}
      dismiss={dismiss}
      error={discard.isError ? discard.error.message : null}
      menu={
        confirming ? (
          <DropdownMenuItem disabled={discard.isPending} onClick={() => setConfirming(false)}>
            Keep tracking
          </DropdownMenuItem>
        ) : undefined
      }
      actions={
        <Button
          variant={confirming ? "destructive" : "outline"}
          disabled={discard.isPending}
          onClick={() => (confirming ? discard.mutate() : setConfirming(true))}
        >
          {discard.isPending ? "Discarding…" : confirming ? "Confirm discard" : "Discard leftovers"}
        </Button>
      }
    />
  );
};

type UnconfiguredWorkerAskProps = {
  readonly need: UnconfiguredWorkerNeed;
  readonly dismiss?: ReactNode;
};

/** Renders the Ask for a Worker no longer declared in `usine.yaml`. Leftovers can be discarded once
 * no Attempt runs on it; until then the entry shows how many still run. */
export const UnconfiguredWorkerAsk = ({ need, dismiss }: UnconfiguredWorkerAskProps) =>
  need.running > 0 ? (
    <NeedItem copy={needCopy(need)} heading={need.worker} dismiss={dismiss} />
  ) : (
    <DiscardLeftoversAsk need={need} dismiss={dismiss} />
  );
