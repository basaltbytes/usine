import type { WorkerConfigurationView } from "@usine/orchestrator/operator";
import { CommandButton } from "~/components/command-palette/button";
import { Spinner } from "~/components/ui/spinner";
import { useWorkerPreflight } from "~/features/configuration/queries";
import {
  preflightBusyReason,
  preflightCommand,
  preflightRunningReason,
  preflightSetupReason,
  runningPreflightLabel,
  runPreflightLabel,
} from "~/features/configuration/strings";
import { rejectionMessage } from "~/lib/api";

type PreflightActionProps = { readonly worker: WorkerConfigurationView };

export const PreflightAction = ({ worker }: PreflightActionProps) => {
  const mutation = useWorkerPreflight(worker.name);
  const running = mutation.isPending || worker.preflightRunning;
  const reason = running
    ? preflightRunningReason
    : worker.slots === null
      ? preflightSetupReason
      : worker.slots.leased > 0
        ? preflightBusyReason
        : null;
  return (
    <div className="flex flex-col items-start gap-1">
      <CommandButton
        command={preflightCommand(worker.name)}
        variant="ghost"
        size="sm"
        disabled={reason !== null}
        aria-label={preflightCommand(worker.name)}
        aria-describedby={reason === null ? undefined : `preflight-${worker.name}-reason`}
        onClick={(event) => {
          event.stopPropagation();
          mutation.mutate();
        }}
      >
        {running && <Spinner />}
        {running ? runningPreflightLabel : runPreflightLabel}
      </CommandButton>
      {reason !== null && (
        <p
          id={`preflight-${worker.name}-reason`}
          className="text-xs text-muted-foreground"
          role="status"
        >
          {reason}
        </p>
      )}
      {mutation.isError && (
        <p role="alert" className="text-xs text-destructive">
          {rejectionMessage(mutation.error)}
        </p>
      )}
    </div>
  );
};
