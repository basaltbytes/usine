import type { MachineView, WorkerConfigurationView } from "@usine/orchestrator/operator";
import { FillCell } from "~/components/fill-cell";
import { StatusBadge } from "~/components/status-badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";
import { CreationFailure } from "~/features/configuration/components/workers/creation-failure";
import { MachineFor } from "~/features/configuration/components/workers/machine-for";
import { DetailSection } from "~/features/configuration/components/section";
import { useNow } from "~/hooks/use-now";
import { elapsedLabel, timestampLabel } from "~/lib/strings";

const machineState = {
  creating: { state: "Queued", label: "Creating" },
  ready: { state: "live", label: "Ready" },
  deleting: { state: "Canceled", label: "Deleting" },
} as const satisfies Record<MachineView["state"], { state: string; label: string }>;

type MachinesProps = { readonly worker: WorkerConfigurationView };

/** Renders a provisioned Worker's last failed machine creation, then its machines oldest first. */
export const Machines = ({ worker }: MachinesProps) => {
  const now = useNow(15_000);
  return (
    <DetailSection title="Machines" aside="Created for each attempt and deleted afterwards">
      {worker.provisioning !== null && <CreationFailure pause={worker.provisioning} now={now} />}
      {worker.machines.length === 0 ? (
        <p className="text-muted-foreground">No machines</p>
      ) : (
        <div className="-mx-2">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="max-sm:w-full">Machine</TableHead>
                <TableHead>State</TableHead>
                <TableHead className="text-right">Age</TableHead>
                <TableHead className="max-sm:hidden">For</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {worker.machines.map((machine, index) => (
                <TableRow
                  key={machine.id ?? `${machine.since}:${index}`}
                  className="hover:bg-transparent"
                >
                  <TableCell className="whitespace-normal max-sm:w-full max-sm:align-top">
                    {machine.id === null ? (
                      <span className="text-muted-foreground">No ID yet</span>
                    ) : (
                      <span className="font-mono text-xs">{machine.id}</span>
                    )}
                    <span className="mt-0.5 block text-xs sm:hidden">
                      <MachineFor machine={machine} />
                    </span>
                  </TableCell>
                  <TableCell className="max-sm:align-top">
                    <StatusBadge {...machineState[machine.state]} />
                  </TableCell>
                  <TableCell
                    className="text-right font-mono text-xs text-muted-foreground tabular-nums max-sm:align-top"
                    title={`Since ${timestampLabel(machine.since)}`}
                  >
                    {elapsedLabel(machine.since, now)}
                  </TableCell>
                  <FillCell className="whitespace-normal max-sm:hidden">
                    <MachineFor machine={machine} />
                  </FillCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </DetailSection>
  );
};
