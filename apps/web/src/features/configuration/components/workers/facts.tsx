import type { WorkerConfigurationView } from "@usine/orchestrator/operator";
import { ContainerLimits } from "~/features/configuration/components/workers/container-limits";
import { ProvisionerFacts } from "~/features/configuration/components/workers/provisioner";
import { Fact, Facts, Unset } from "~/features/configuration/components/section";
import { workerKindLabel } from "~/features/configuration/strings";

type WorkerFactsProps = { readonly worker: WorkerConfigurationView };

export const WorkerFacts = ({ worker }: WorkerFactsProps) => (
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
