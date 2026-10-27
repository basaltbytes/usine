import type { ConfigurationView } from "@usine/orchestrator/operator";
import { Table, TableBody, TableHead, TableHeader, TableRow } from "~/components/ui/table";
import { ConfigurationPage } from "~/features/configuration/components/section";
import { WorkerRow } from "~/features/configuration/components/workers/row";
import { plural } from "~/features/configuration/strings";

type WorkersListProps = { readonly configuration: ConfigurationView };

/** Renders the Workers declared in `usine.yaml`, then the Workers removed by a reload that still run Attempts. */
export const WorkersList = ({ configuration }: WorkersListProps) => {
  const running = configuration.workers.some(({ slots }) => slots !== null);
  return (
    <ConfigurationPage title="Workers" counts={plural(configuration.workers.length, "worker")}>
      {!running && (
        <p className="text-muted-foreground">No attempts run until the GitHub App is set up.</p>
      )}
      <div className="@container -mx-2">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Worker</TableHead>
              <TableHead>Kind</TableHead>
              <TableHead className="hidden @2xl:table-cell">Location</TableHead>
              <TableHead>Slots in use</TableHead>
              <TableHead>Last preflight</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {configuration.workers.map((worker) => (
              <WorkerRow key={worker.name} worker={worker} />
            ))}
          </TableBody>
        </Table>
      </div>
      {configuration.removedWorkers.length > 0 && (
        <ul className="flex flex-col gap-1 text-muted-foreground">
          {configuration.removedWorkers.map(({ name, running: attempts }) => (
            <li key={name}>
              <span className="font-mono text-xs text-foreground">{name}</span> removed by a reload,{" "}
              {plural(attempts, "attempt")} still running
            </li>
          ))}
        </ul>
      )}
    </ConfigurationPage>
  );
};
