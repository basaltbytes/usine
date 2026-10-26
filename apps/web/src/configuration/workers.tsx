import { Link, useNavigate } from "@tanstack/react-router";
import type {
  ConfigurationView,
  ContainerView,
  MachineView,
  PreflightCheckView,
  ProvisioningPauseView,
  WorkerConfigurationView,
  WorkerSlotsView,
} from "@usine/orchestrator/operator";
import { FillCell } from "@/components/fill-cell";
import { StatusBadge } from "@/components/status-badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useNow } from "@/hooks/use-now";
import { cn } from "@/lib/utils";
import {
  creationFailuresLine,
  creationFailureTitle,
  dayTimeLabel,
  elapsedLabel,
  nextCreationLine,
  providerLabel,
  timestampLabel,
} from "../operator-copy.ts";
import {
  containerLimitSources,
  containerLimitsLabel,
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

const summaryBadge = {
  passed: { state: "Succeeded", label: "Passed" },
  degraded: { state: "Waiting", label: "Degraded" },
  deferred: { state: "Deferred", label: "Deferred" },
  failed: { state: "Failed", label: "Failed" },
} as const;

const PreflightState = ({ worker }: { readonly worker: WorkerConfigurationView }) => {
  const { state, checkedAt } = preflightSummary(worker);
  if (state === "unchecked") return <span className="text-muted-foreground">Not checked</span>;
  return (
    <span className="inline-flex items-baseline gap-2">
      <StatusBadge {...summaryBadge[state]} />
      {checkedAt !== null && (
        <span className="font-mono text-xs text-muted-foreground tabular-nums">
          {dayTimeLabel(checkedAt)}
        </span>
      )}
    </span>
  );
};

/** Renders a provisioned Worker's last failed machine creation and when it creates one again. */
const CreationFailure = ({
  pause,
  now,
}: {
  readonly pause: ProvisioningPauseView;
  readonly now: number;
}) => (
  <div className="rounded-lg border border-destructive/25 bg-destructive/8 px-3 pt-2 pb-2.5 text-sm">
    <p className="font-medium text-destructive">{creationFailureTitle(pause)}</p>
    <p className="wrap-anywhere">{pause.message}</p>
    <p className="mt-1 text-xs text-muted-foreground tabular-nums">
      {creationFailuresLine(pause, now)}. {nextCreationLine(pause, now)}
    </p>
  </div>
);

const WorkerRow = ({ worker }: { readonly worker: WorkerConfigurationView }) => {
  const now = useNow(15_000);
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
      <FillCell className="whitespace-normal">
        <PreflightState worker={worker} />
        {worker.provisioning?.blocked === true && (
          <p className="text-xs text-destructive tabular-nums" title={worker.provisioning.message}>
            {creationFailureTitle(worker.provisioning)}.{" "}
            {nextCreationLine(worker.provisioning, now)}
          </p>
        )}
      </FillCell>
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

const CheckResult = ({ check }: { readonly check: PreflightCheckView }) => {
  switch (check._tag) {
    case "Passed":
      return <StatusBadge state="Succeeded" label="Passed" />;
    case "Degraded":
      return <StatusBadge state="Waiting" label="Degraded: no container per attempt" />;
    case "Deferred":
      return <StatusBadge state="Deferred" label="Deferred" />;
    case "Failed":
      return <StatusBadge state="Failed" label={`Failed: ${failedCheckLabel(check)}`} />;
  }
};

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
    <FillCell className="py-3 align-top whitespace-normal wrap-anywhere">
      {check._tag === "Passed" ? null : check.message}
    </FillCell>
  </TableRow>
);

/** Renders the name of the orchestrator environment variable that holds a secret, never its value. */
const Variable = ({ name }: { readonly name: string | null }) =>
  name === null ? (
    <Unset>Not set</Unset>
  ) : (
    <>
      <Unset>Read from </Unset>
      <code className="font-mono text-xs">{name}</code>
    </>
  );

const ProvisionerFacts = ({
  provisioner,
}: {
  readonly provisioner: NonNullable<WorkerConfigurationView["provisioner"]>;
}) => (
  <div className="flex flex-col gap-3">
    <h2 className="text-md font-semibold">Provisioner</h2>
    <Facts>
      <Fact label="Provider">{providerLabel[provisioner._tag]}</Fact>
      {provisioner._tag === "hetzner" ? (
        <>
          <Fact label="Server type">
            <code className="font-mono text-xs">{provisioner.serverType}</code>
          </Fact>
          <Fact label="Location">
            <code className="font-mono text-xs">{provisioner.location}</code>
          </Fact>
          <Fact label="Image">
            <code className="font-mono text-xs">{provisioner.image}</code>
          </Fact>
          <Fact label="Network">
            {provisioner.network === null ? (
              <Unset>None; each server has a public address</Unset>
            ) : (
              <code className="font-mono text-xs">{provisioner.network}</code>
            )}
          </Fact>
          <Fact label="Firewall">
            {provisioner.firewall === null ? (
              <Unset>None</Unset>
            ) : (
              <code className="font-mono text-xs">{provisioner.firewall}</code>
            )}
          </Fact>
          <Fact label="SSH key">
            <code className="font-mono text-xs">{provisioner.sshKey}</code>
          </Fact>
          <Fact label="SSH user">
            <code className="font-mono text-xs">{provisioner.sshUser}</code>
          </Fact>
          {Object.keys(provisioner.labels).length > 0 && (
            <Fact label="Labels">
              <code className="font-mono text-xs">
                {Object.entries(provisioner.labels)
                  .map(([key, value]) => `${key}=${value}`)
                  .join(", ")}
              </code>
            </Fact>
          )}
        </>
      ) : (
        <Fact label="Size">
          <code className="font-mono text-xs">{provisioner.size}</code>
        </Fact>
      )}
      <Fact label="API token">
        <Variable name={provisioner.tokenEnv} />
      </Fact>
      <Fact label="Anthropic key">
        <Variable name={provisioner.anthropicKeyEnv} />
      </Fact>
      <Fact label="OpenAI key">
        <Variable name={provisioner.openaiKeyEnv} />
      </Fact>
    </Facts>
  </div>
);

const WorkerFacts = ({ worker }: { readonly worker: WorkerConfigurationView }) => (
  <div className="flex flex-col gap-6">
    <Facts>
      <Fact label="Kind">{workerKindLabel[worker.kind]}</Fact>
      <Fact label="Max attempts">
        <span className="tabular-nums">{worker.maxConcurrentAttempts}</span>{" "}
        <Unset>
          {worker.provisioner === null ? "at the same time" : "at the same time, one machine each"}
        </Unset>
      </Fact>
      {worker.destination !== null && (
        <Fact label="Destination">
          <code className="font-mono text-xs">{worker.destination}</code>
        </Fact>
      )}
      {worker.kind === "ssh" && worker.provisioner === null && (
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
    {worker.provisioner !== null && <ProvisionerFacts provisioner={worker.provisioner} />}
    {worker.container !== null && (
      <div className="flex flex-col gap-3">
        <h2 className="text-md font-semibold">Attempt container</h2>
        <Facts>
          <Fact label="Image">
            {worker.container.image === null ? (
              <Unset>Default for this release</Unset>
            ) : (
              <code className="font-mono text-xs wrap-anywhere">{worker.container.image}</code>
            )}
          </Fact>
          <Fact label="Limits">
            <ContainerLimits container={worker.container} applied={worker.containerLimits} />
          </Fact>
        </Facts>
      </div>
    )}
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

/**
 * Renders the limits of each Attempt container: the ones the last preflight of the machine
 * applied, else the ones `usine.yaml` sets, and which ones preflight derives from the machine.
 */
const ContainerLimits = ({
  container,
  applied,
}: {
  readonly container: ContainerView;
  readonly applied: WorkerConfigurationView["containerLimits"];
}) => {
  const { configured, derived } = containerLimitSources(container);
  const shown = applied === null ? configured : containerLimitsLabel(applied);
  const note =
    applied === null
      ? "Derived from the machine at preflight"
      : "Derived from the machine at the last preflight";
  return (
    <span className="flex flex-col gap-1">
      {shown !== null && <span className="tabular-nums">{shown}</span>}
      {derived !== null && <Unset>{`${note}: ${derived}`}</Unset>}
    </span>
  );
};

const machineState = {
  creating: { state: "Queued", label: "Creating" },
  ready: { state: "live", label: "Ready" },
  deleting: { state: "Canceled", label: "Deleting" },
} as const satisfies Record<MachineView["state"], { state: string; label: string }>;

/** Renders the Run a machine serves, which opens its drawer, or its Attempt after a restart. */
const MachineFor = ({ machine }: { readonly machine: MachineView }) => {
  const { runId, attemptId } = machine;
  if (runId !== null)
    return (
      <Link
        to="."
        search={(previous) => ({ ...previous, run: runId })}
        className="text-primary hover:underline"
      >
        Run <span className="font-mono text-xs">{runId.slice(0, 8)}</span>
      </Link>
    );
  if (attemptId === null) return <Unset>Found after a restart</Unset>;
  return (
    <span>
      Attempt <span className="font-mono text-xs">{attemptId.slice(0, 8)}</span>
      <Unset>, found after a restart</Unset>
    </span>
  );
};

/** Renders a provisioned Worker's last failed machine creation, then its machines oldest first. */
const Machines = ({ worker }: { readonly worker: WorkerConfigurationView }) => {
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
                  <FillCell className="max-sm:hidden">
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
            <div className="flex items-center gap-3">
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
            <div className="-mx-2">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>Check</TableHead>
                    <TableHead>Result</TableHead>
                    <TableHead>Checked</TableHead>
                    <TableHead>Detail</TableHead>
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
