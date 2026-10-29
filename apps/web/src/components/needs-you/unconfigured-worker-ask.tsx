import type { ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { UnconfiguredWorkerNeed } from "@usine/orchestrator/operator";
import { useState } from "react";
import { DropdownMenuItem } from "~/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { Button } from "~/components/ui/button";
import { api } from "~/lib/api";
import { needCopy, needDetailsLabel } from "~/lib/needs-you/strings";
import { overviewQuery } from "~/lib/overview";
import { NeedItem } from "~/components/needs-you/need-item";

type UnconfiguredWorkerAskProps = {
  readonly need: UnconfiguredWorkerNeed;
  readonly dismiss?: ReactNode;
};

export const UnconfiguredWorkerAsk = ({ need, dismiss }: UnconfiguredWorkerAskProps) => {
  const queries = useQueryClient();
  const [showDetails, setShowDetails] = useState(false);
  const copy = needCopy(need);
  const [confirming, setConfirming] = useState(false);
  const discard = useMutation({
    mutationFn: () => api((client) => client.discardLeftovers({ params: { worker: need.worker } })),
    onSuccess: () => queries.invalidateQueries({ queryKey: overviewQuery().queryKey }),
  });
  return (
    <>
      <NeedItem
        copy={copy}
        heading={need.worker}
        dismiss={dismiss}
        error={discard.isError ? discard.error.message : null}
        menu={
          <>
            <DropdownMenuItem onClick={() => setShowDetails(true)}>
              {needDetailsLabel}
            </DropdownMenuItem>
            {confirming && (
              <DropdownMenuItem disabled={discard.isPending} onClick={() => setConfirming(false)}>
                Keep tracking
              </DropdownMenuItem>
            )}
          </>
        }
        actions={
          need.running === 0 ? (
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
          ) : undefined
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
