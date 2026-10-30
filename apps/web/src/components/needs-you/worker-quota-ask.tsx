import type { ReactNode } from "react";
import { useState } from "react";
import { Link } from "@tanstack/react-router";
import type { WorkerQuotaNeed } from "@usine/orchestrator/operator";
import { Button } from "~/components/ui/button";
import { DropdownMenuItem } from "~/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { needCopy, needDetailsLabel, openWorkerLabel } from "~/lib/needs-you/strings";
import { NeedItem } from "./need-item";

type WorkerQuotaAskProps = {
  readonly need: WorkerQuotaNeed;
  readonly dismiss?: ReactNode;
};

export const WorkerQuotaAsk = ({ need, dismiss }: WorkerQuotaAskProps) => {
  const [showDetails, setShowDetails] = useState(false);
  const copy = needCopy(need);
  return (
    <>
      <NeedItem
        copy={copy}
        heading={`${need.worker} · ${need.message}`}
        dismiss={dismiss}
        menu={
          <DropdownMenuItem onClick={() => setShowDetails(true)}>
            {needDetailsLabel}
          </DropdownMenuItem>
        }
        actions={
          <Button
            variant="ghost"
            nativeButton={false}
            render={<Link to="/configuration/workers/$worker" params={{ worker: need.worker }} />}
          >
            {openWorkerLabel}
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
