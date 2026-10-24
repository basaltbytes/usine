import { Link, useNavigate } from "@tanstack/react-router";
import type {
  ConfigurationView,
  PreflightCheckView,
  WorkerConfigurationView,
  WorkerSlotsView,
} from "@usine/orchestrator/operator";
import { StatusBadge } from "@/components/status-badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { dayTimeLabel } from "../operator-copy.ts";
import {
  failedCheckLabel,
  harnessLabel,
  plural,
  preflightSummary,
  workerKindLabel,
  workerPlace,
} from "./copy.ts";
import {
  ConfigurationPage,
  DetailColumns,
  DetailSection,
  Fact,
  Facts,
  Missing,
  OpeningRow,
  rowLinkClass,
  Unset,
} from "./section.tsx";

const slotsLabel = ({ capacity, leased }: WorkerSlotsView): string =>
  `${leased} of ${plural(capacity, "slot")} in use`;

/** Renders one cell per slot, filled while an Attempt uses it. If a reload lowers
 * `max_concurrent_attempts`, Attempts still running above the limit add filled cells. */
const SlotCells = ({ slots }: { readonly slots: WorkerSlotsView }) => (
  <span aria-hidden="true" className="inline-flex flex-wrap gap-1">
    {Array.from({ length: Math.max(slots.capacity, slots.leased) }, (_, index) => (
      <span
        key={index}
        className={cn(
          "size-2.5 rounded-xs ring-1 ring-inset",
          index < slots.leased ? "bg-run-active ring-run-active" : "ring-input",
        )}
      />
    ))}
  </span>
);

const PreflightState = ({ worker }: { readonly worker: WorkerConfigurationView }) => {
  const { state, checkedAt } = preflightSummary(worker);
  if (state === "unchecked") return <span className="text-muted-foreground">Not checked</span>;
  return (
    <span className="inline-flex items-baseline gap-2">
      <StatusBadge
        state={state === "failed" ? "Failed" : "Succeeded"}
        label={state === "failed" ? "Failed" : "Passed"}
      />
      {checkedAt !== null && (
        <span className="font-mono text-xs text-muted-foreground tabular-nums">
          {dayTimeLabel(checkedAt)}
        </span>
      )}
    </span>
  );
};

const WorkerRow = ({ worker }: { readonly worker: WorkerConfigurationView }) => {
  const navigate = useNavigate();
  const params = { worker: worker.name };
  return (
    <OpeningRow open={() => void navigate({ to: "/configuration/workers/$worker", params })}>
      <TableCell className="py-3">
        <Link
          to="/configuration/workers/$worker"
          params={params}
          onClick={(event) => event.stopPropagation()}
          className={rowLinkClass}
        >
          {worker.name}
        </Link>
      </TableCell>
      <TableCell>{workerKindLabel[worker.kind]}</TableCell>
      <TableCell className="hidden font-mono text-xs md:table-cell">
        {workerPlace(worker)}
      </TableCell>
      <TableCell className="tabular-nums">
        {worker.slots === null ? (
          <span className="text-muted-foreground">{worker.maxConcurrentAttempts} max</span>
        ) : (
          <span className="inline-flex items-center gap-2">
            <SlotCells slots={worker.slots} />
            <span className="max-sm:sr-only">
              {worker.slots.leased} of {worker.slots.capacity}
            </span>
          </span>
        )}
      </TableCell>
      <TableCell className="w-full">
        <PreflightState worker={worker} />
      </TableCell>
    </OpeningRow>
  );
};

/** Renders the Workers declared in `usine.yaml`, then the Workers removed by a reload that still run Attempts. */
export const WorkersList = ({ configuration }: { readonly configuration: ConfigurationView }) => {
  const running = configuration.workers.some(({ slots }) => slots !== null);
  return (
    <ConfigurationPage title="Workers" counts={plural(configuration.workers.length, "worker")}>
      {!running && (
        <p className="text-muted-foreground">No attempts run until the GitHub App is set up.</p>
      )}
      <div className="-mx-2">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Worker</TableHead>
              <TableHead>Kind</TableHead>
              <TableHead className="hidden md:table-cell">Location</TableHead>
              <TableHead>Slots in use</TableHead>
              <TableHead className="w-full">Last preflight</TableHead>
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

const CheckResult = ({ check }: { readonly check: PreflightCheckView }) =>
  check._tag === "Passed" ? (
    <StatusBadge state="Succeeded" label="Passed" />
  ) : (
    <StatusBadge state="Failed" label={`Failed: ${failedCheckLabel(check)}`} />
  );

const CheckRow = ({
  subject,
  detail,
  check,
}: {
  readonly subject: string;
  readonly detail: string;
  readonly check: PreflightCheckView;
}) => (
  <TableRow className="hover:bg-transparent">
    <TableCell className="py-3 align-top whitespace-normal">
      <p className="font-medium">{subject}</p>
      <p className="text-xs text-muted-foreground">{detail}</p>
    </TableCell>
    <TableCell className="py-3 align-top">
      <CheckResult check={check} />
    </TableCell>
    <TableCell className="py-3 align-top font-mono text-xs text-muted-foreground tabular-nums">
      {dayTimeLabel(check.checkedAt)}
    </TableCell>
    <TableCell className="w-full py-3 align-top whitespace-normal wrap-anywhere">
      {check._tag === "Failed" ? check.message : null}
    </TableCell>
  </TableRow>
);

const WorkerFacts = ({ worker }: { readonly worker: WorkerConfigurationView }) => (
  <div className="flex flex-col gap-6">
    <Facts>
      <Fact label="Kind">{workerKindLabel[worker.kind]}</Fact>
      <Fact label="Max attempts">
        <span className="tabular-nums">{worker.maxConcurrentAttempts}</span>{" "}
        <Unset>at the same time</Unset>
      </Fact>
      {worker.destination !== null && (
        <Fact label="Destination">
          <code className="font-mono text-xs">{worker.destination}</code>
        </Fact>
      )}
      {worker.kind === "ssh" && (
        <Fact label="Port">
          {worker.port === null ? (
            <Unset>From the SSH configuration</Unset>
          ) : (
            <code className="font-mono text-xs">{worker.port}</code>
          )}
        </Fact>
      )}
      {worker.kind === "ssh" && (
        <Fact label="Identity file">
          {worker.identityFile === null ? (
            <Unset>From the SSH configuration</Unset>
          ) : (
            <code className="font-mono text-xs">{worker.identityFile}</code>
          )}
        </Fact>
      )}
      {worker.root !== null && (
        <Fact label="Root">
          <code className="font-mono text-xs">{worker.root}</code>
        </Fact>
      )}
    </Facts>
    {worker.gateway !== null && (
      <div className="flex flex-col gap-3">
        <h2 className="text-md font-semibold">Gateway</h2>
        <Facts>
          <Fact label="Domain">
            <code className="font-mono text-xs">{worker.gateway.domain}</code>
          </Fact>
          <Fact label="Destination">
            <code className="font-mono text-xs">{worker.gateway.destination}</code>
          </Fact>
          <Fact label="Admin port">
            <code className="font-mono text-xs">{worker.gateway.adminPort}</code>
          </Fact>
          <Fact label="Admin token">
            <Unset>Read from </Unset>
            <code className="font-mono text-xs">{worker.gateway.adminTokenEnv}</code>
          </Fact>
          <Fact label="LLM credentials">
            {worker.gateway.llmProviders.length === 0 ? (
              <Unset>None; each harness uses the login on the worker</Unset>
            ) : (
              worker.gateway.llmProviders.join(", ")
            )}
          </Fact>
        </Facts>
      </div>
    )}
  </div>
);

export const WorkerDetail = ({
  name,
  configuration,
}: {
  readonly name: string;
  readonly configuration: ConfigurationView;
}) => {
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
            detail: "Machine, Git, memory, gateway, and credentials",
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
            <div className="flex items-center gap-3">
              <SlotCells slots={worker.slots} />
              <p className="tabular-nums">{slotsLabel(worker.slots)}</p>
            </div>
          )}
        </DetailSection>
        <DetailSection
          title="Preflight"
          aside="At startup, and when a reload adds workers, slots, or an agent with a new harness, model, or effort"
        >
          {checks.length === 0 ? (
            <p className="text-muted-foreground">No preflight since usine up started.</p>
          ) : (
            <div className="-mx-2">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>Check</TableHead>
                    <TableHead>Result</TableHead>
                    <TableHead>Checked</TableHead>
                    <TableHead className="w-full">Detail</TableHead>
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
