import { catalog } from "@usine/agents/harness";
import type { Worker } from "@usine/config/factory";
import {
  type CredentialHolderOf,
  GatewayCredentialHolder,
  WorkerCredentialHolder,
} from "@usine/core/worker";
import { Option } from "effect";

/**
 * Returns who holds the credential that each harness uses on each of `workers`: the Gateway of an
 * SSH Worker whose `llm_providers` lists the harness's provider, and otherwise the Worker, with its
 * own login or its provisioner's API key. A Worker that `workers` doesn't declare holds its own.
 */
export const credentialHolderOf = (workers: ReadonlyArray<Worker>): CredentialHolderOf => {
  const declared = new Map(workers.map((worker) => [worker.name, worker]));
  return (name, harness) => {
    const worker = declared.get(name);
    const gateway = worker?.kind === "ssh" ? worker.gateway : Option.none();
    const served = Option.filter(gateway, ({ llmProviders }) =>
      catalog.gatewayHolds(harness, llmProviders),
    );
    return Option.match(served, {
      onSome: ({ destination }) => GatewayCredentialHolder.make({ destination }),
      onNone: () => WorkerCredentialHolder.make({ worker: name }),
    });
  };
};
