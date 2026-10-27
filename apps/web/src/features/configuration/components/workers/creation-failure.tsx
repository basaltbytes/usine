import type { ProvisioningPauseView } from "@usine/orchestrator/operator";
import {
  creationFailuresLine,
  creationFailureTitle,
  nextCreationLine,
} from "~/lib/workers/strings";

type CreationFailureProps = {
  readonly pause: ProvisioningPauseView;
  readonly now: number;
};

/** Renders a provisioned Worker's last failed machine creation and when it creates one again. */
export const CreationFailure = ({ pause, now }: CreationFailureProps) => (
  <div className="rounded-lg border border-destructive/25 bg-destructive/8 px-3 pt-2 pb-2.5 text-sm">
    <p className="font-medium text-destructive">{creationFailureTitle(pause)}</p>
    <p className="wrap-anywhere">{pause.message}</p>
    <p className="mt-1 text-xs text-muted-foreground tabular-nums">
      {creationFailuresLine(pause, now)}. {nextCreationLine(pause, now)}
    </p>
  </div>
);
