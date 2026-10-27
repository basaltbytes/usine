import type { WorkerConfigurationView } from "@usine/orchestrator/operator";
import { Fact, Facts, Unset } from "~/features/configuration/components/section";
import { Variable } from "~/features/configuration/components/workers/variable";
import { providerLabel } from "~/lib/workers/strings";

type ProvisionerFactsProps = {
  readonly provisioner: NonNullable<WorkerConfigurationView["provisioner"]>;
};

export const ProvisionerFacts = ({ provisioner }: ProvisionerFactsProps) => (
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
