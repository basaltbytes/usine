import type { ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { UnconfiguredWorkerNeed } from "@usine/orchestrator/operator";
import { useState } from "react";
import { Button } from "~/components/ui/button";
import { api } from "~/lib/api";
import { needCopy } from "~/lib/needs-you/strings";
import { overviewQuery } from "~/lib/overview";
import { NeedItem } from "~/components/needs-you/need-item";

type DiscardLeftoversAskProps = {
  readonly need: UnconfiguredWorkerNeed;
  readonly compact: boolean;
  readonly dismiss?: ReactNode;
};

/** Discards leftovers after a confirmation; a rejection, such as for a Worker declared again since
 * the overview loaded, is shown under the entry. */
const DiscardLeftoversAsk = ({ need, compact, dismiss }: DiscardLeftoversAskProps) => {
  const queries = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const discard = useMutation({
    mutationFn: () => api((client) => client.discardLeftovers({ params: { worker: need.worker } })),
    onSuccess: () => queries.invalidateQueries({ queryKey: overviewQuery().queryKey }),
  });
  return (
    <NeedItem
      copy={needCopy(need)}
      compact={compact}
      dismiss={dismiss}
      fullDetail
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

type UnconfiguredWorkerAskProps = {
  readonly need: UnconfiguredWorkerNeed;
  readonly compact: boolean;
  readonly dismiss?: ReactNode;
};

/** Renders the Ask for a Worker no longer declared in `usine.yaml`. Leftovers can be discarded once
 * no Attempt runs on it; until then the entry shows how many still run. */
export const UnconfiguredWorkerAsk = ({ need, compact, dismiss }: UnconfiguredWorkerAskProps) =>
  need.running > 0 ? (
    <NeedItem copy={needCopy(need)} compact={compact} dismiss={dismiss} fullDetail />
  ) : (
    <DiscardLeftoversAsk need={need} compact={compact} dismiss={dismiss} />
  );
