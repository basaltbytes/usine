import { Link } from "@tanstack/react-router";
import type { ConfigurationView, WorkerSlotsView } from "@usine/orchestrator/operator";
import { Table, TableBody, TableHead, TableHeader, TableRow } from "~/components/ui/table";
import { CheckRow } from "~/features/configuration/components/workers/check-row";
import { Machines } from "~/features/configuration/components/workers/machines";
import {
  ConfigurationPage,
  DetailColumns,
  DetailSection,
  Missing,
} from "~/features/configuration/components/section";
import { SlotCells } from "~/features/configuration/components/workers/slots";
import { WorkerFacts } from "~/features/configuration/components/workers/facts";
import { harnessLabel, plural, workerKindLabel } from "~/features/configuration/strings";

const slotsLabel = ({ capacity, leased }: WorkerSlotsView): string =>
  `${leased} of ${plural(capacity, "slot")} in use`;

type WorkerDetailProps = {
  readonly name: string;
  readonly configuration: ConfigurationView;
};

export const WorkerDetail = ({ name, configuration }: WorkerDetailProps) => {
  const worker = configuration.workers.find((candidate) => candidate.name === name);
  if (worker === undefined)
    return (
      <ConfigurationPage title={name}>
        <Missing title="Worker not found">
          <code>usine.yaml</code> has no worker {name}.{" "}
          <Link to="/configuration/workers" className="text-primary hover:underline">
            See all workers
          </Link>
          .
        </Missing>
      </ConfigurationPage>
    );
  const checks = [
    ...(worker.prerequisites === null
      ? []
      : [
          {
            subject: "Worker",
            detail:
              worker.provisioner !== null
                ? "Provider, gateway, and credentials"
                : worker.kind === "ssh"
                  ? "Machine, Git, memory, gateway, credentials, and Docker"
                  : "Machine, Git, memory, gateway, and credentials",
            check: worker.prerequisites,
          },
        ]),
    ...worker.harnesses.map(({ harness, check }) => ({
      subject: harnessLabel[harness],
      detail: "Harness installed and logged in",
      check,
    })),
  ];
  return (
    <ConfigurationPage
      title={worker.name}
      marks={
        <span className="text-sm text-muted-foreground">{workerKindLabel[worker.kind]} worker</span>
      }
    >
      <DetailColumns facts={<WorkerFacts worker={worker} />}>
        <DetailSection title="Slots">
          {worker.slots === null ? (
            <p className="text-muted-foreground">No attempts run until the GitHub App is set up.</p>
          ) : (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <SlotCells slots={worker.slots} />
              <p className="tabular-nums">{slotsLabel(worker.slots)}</p>
            </div>
          )}
        </DetailSection>
        {worker.provisioner !== null && <Machines worker={worker} />}
        <DetailSection
          title="Preflight"
          aside="At startup, and when a reload adds workers, slots, or an agent with a new harness, model, or effort"
        >
          {worker.provisioner !== null && (
            <p className="text-muted-foreground">
              Harness checks run on the first machine of each day.
            </p>
          )}
          {checks.length === 0 ? (
            <p className="text-muted-foreground">No preflight since usine up started.</p>
          ) : (
            <div className="@container -mx-2">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>Check</TableHead>
                    <TableHead>Result</TableHead>
                    <TableHead className="hidden @2xl:table-cell">Checked</TableHead>
                    <TableHead className="hidden @2xl:table-cell">Detail</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {checks.map(({ subject, detail, check }) => (
                    <CheckRow key={subject} subject={subject} detail={detail} check={check} />
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </DetailSection>
      </DetailColumns>
    </ConfigurationPage>
  );
};
