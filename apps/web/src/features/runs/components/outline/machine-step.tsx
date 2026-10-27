import type { MachineView } from "@usine/orchestrator/operator";
import { Elapsed } from "~/components/runs/transcript/activity";
import { StateMark } from "~/components/status-badge";
import { dayTimeLabel, timestampLabel } from "~/lib/strings";
import { providerLabel } from "~/lib/workers/strings";

type MachineStepProps = {
  readonly machine: MachineView;
  readonly attemptNumber: number;
};

/** Renders the machine that a provisioned Worker creates for a queued Run's next Attempt. */
export const MachineStep = ({ machine, attemptNumber }: MachineStepProps) => (
  <div className="relative rounded-md py-1.5 pr-2 pl-6">
    <StateMark state="Queued" className="absolute top-3 left-2.5" />
    <span className="block font-medium">
      {machine.state === "creating" ? "Creating machine" : "Machine ready"}
    </span>
    <span className="block truncate text-xs text-muted-foreground">
      {providerLabel[machine.provider]}
      {machine.id !== null && <span className="font-mono"> {machine.id}</span>}, for attempt{" "}
      {attemptNumber}
    </span>
    <span className="flex justify-between gap-3 font-mono text-xs tabular-nums text-muted-foreground">
      <time dateTime={machine.since} title={timestampLabel(machine.since)}>
        {dayTimeLabel(machine.since)}
      </time>
      <Elapsed since={machine.since} />
    </span>
  </div>
);
