import { admitBrain, AdmissionContext, catalog } from "@usine/agents/harness";
import { Option, Result } from "effect";
import type { AgentFile } from "../agent.ts";
import type { UsineConfig } from "../factory.ts";
import { ConfigFileError, InstancePath } from "../file.ts";

/** Returns role and placement refusals for the configured agents on every worker. */
export const brainAdmissionProblems = (
  config: UsineConfig,
  agents: ReadonlyArray<AgentFile>,
): Array<ConfigFileError> =>
  agents.flatMap((file) =>
    config.workers.flatMap((worker) => {
      const brain = file.agent.brain;
      const provider = Option.flatMap(
        catalog.get(brain.harness),
        (descriptor) => descriptor.worker.credential,
      );
      const gateway =
        worker.kind === "ssh" &&
        Option.isSome(worker.gateway) &&
        Option.isSome(provider) &&
        worker.gateway.value.llmProviders.includes(provider.value.protocol);
      const context = AdmissionContext.make({
        placement:
          worker.kind === "local"
            ? "local"
            : worker.kind === "cloudflare"
              ? "sandbox"
              : worker.kind === "ssh"
                ? "container"
                : "ssh",
        credential: gateway
          ? "gateway"
          : worker.kind === "cloudflare" ||
              (worker.kind === "ssh" && Option.isSome(worker.provisioner))
            ? "api-key"
            : "host-login",
      });
      const admitted = admitBrain(catalog, "coding-agent", brain, context);
      return Result.isSuccess(admitted)
        ? []
        : [
            ConfigFileError.make({
              file: InstancePath.make(`agents/${file.name}.md`),
              stage: "schema",
              expression: Option.none(),
              message: `Agent "${file.name}" on worker "${worker.name}": ${admitted.failure.message}`,
            }),
          ];
    }),
  );
