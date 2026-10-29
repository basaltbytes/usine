import { useQuery } from "@tanstack/react-query";
import type { LoopName } from "@usine/core/loop";
import { LoopPreviewRequest } from "@usine/orchestrator/operator/http";
import { ErrorAlert } from "~/components/error-alert";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "~/components/ui/dialog";
import { entityKey } from "~/features/configuration/lib/entities";
import { entityQuery, loopPreviewQuery } from "~/features/configuration/queries";
import { loopFormCopy } from "~/features/configuration/strings";
import type { PauseLoop } from "./list";

type ResumeLoopProps = {
  readonly name: LoopName;
  readonly pause: PauseLoop;
  readonly close: () => void;
};
export const ResumeLoop = ({ name, pause, close }: ResumeLoopProps) => {
  const entity = useQuery({ ...entityQuery(entityKey("loop", name)), staleTime: 0 });
  const preview = useQuery({
    ...loopPreviewQuery(new LoopPreviewRequest({ name, value: entity.data?.value ?? null })),
    enabled: entity.isSuccess && !entity.isFetching,
  });
  const ready = entity.isSuccess && !entity.isFetching && preview.isSuccess && !preview.isFetching;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pause.isPending) close();
      }}
    >
      <DialogContent>
        <DialogTitle>
          {loopFormCopy.confirm}: {name}
        </DialogTitle>
        <DialogDescription>{loopFormCopy.resumeHint}</DialogDescription>
        {entity.isError && <ErrorAlert message={entity.error.message} />}
        {preview.isError && <ErrorAlert message={preview.error.message} />}
        {pause.isError && <ErrorAlert message={pause.error.message} />}
        {!ready && !entity.isError && !preview.isError && (
          <p role="status">{loopFormCopy.previewing}</p>
        )}
        {ready && (
          <div className="space-y-2">
            <p>{loopFormCopy.count(preview.data.total, preview.data.total)}</p>
            {preview.data.stream === "schedule" && <p>{loopFormCopy.schedule}</p>}
            {preview.data.repositoriesWithoutItems.length > 0 && (
              <p>{loopFormCopy.noData(preview.data.repositoriesWithoutItems)}</p>
            )}
            {preview.data.failures.map((failure, index) => (
              <ErrorAlert key={`${failure.itemKey}:${index}`} message={failure.message} />
            ))}
          </div>
        )}
        <DialogFooter>
          <Button variant="ghost" disabled={pause.isPending} onClick={close}>
            {loopFormCopy.cancel}
          </Button>
          <Button
            disabled={!ready || pause.isPending}
            onClick={() => pause.mutate({ loop: name, paused: true }, { onSuccess: close })}
          >
            {loopFormCopy.resume}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
