import { NodeServices } from "@effect/platform-node";
import type { SshWorker, UsineConfig } from "@usine/config/factory";
import type { BrainSpec } from "@usine/core/agent/brain";
import type { InstanceDirectory } from "@usine/core/instance";
import { layer as localEngineLayer } from "@usine/engine/local-sqlite";
import { WorkerCapabilityError } from "@usine/executor";
import {
  layer as sshExecutorLayer,
  type SshExecutorOptions,
  type SshWorkerAddress,
} from "@usine/executor/ssh";
import { Config, Effect, Layer, Option } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { stepExecutorLayer } from "./scheduler.ts";

/** The SSH Workers `usine.yaml` declares, in their declared order. */
export const sshWorkersOf = (config: UsineConfig): ReadonlyArray<SshWorker> =>
  config.workers.filter((worker): worker is SshWorker => worker.kind === "ssh");

/**
 * How the executor reaches each SSH Worker `usine.yaml` declares, in their
 * declared order. The admin token of a Worker's Gateway is read here, once,
 * from the environment variable its `admin_token_env` names; an unset
 * variable fails startup with a `gateway` capability error naming the
 * Worker and the variable.
 */
export const sshWorkerAddressesOf = Effect.fn("Orchestrator.sshWorkerAddressesOf")(function* (
  config: UsineConfig,
) {
  return yield* Effect.forEach(sshWorkersOf(config), (worker) =>
    Effect.gen(function* () {
      const gateway = yield* Effect.transposeOption(
        Option.map(worker.gateway, (settings) =>
          Effect.gen(function* () {
            const adminToken = yield* Config.redacted(settings.adminTokenEnv);
            return {
              domain: settings.domain,
              adminUrl: settings.adminUrl,
              adminToken,
              llmProviders: settings.llmProviders,
            };
          }).pipe(
            Effect.mapError(
              (cause) =>
                new WorkerCapabilityError({
                  worker: worker.name,
                  capability: "gateway",
                  message: `SSH Worker ${worker.name}'s Gateway admin token is missing: set ${settings.adminTokenEnv} in the orchestrator's environment`,
                  cause,
                }),
            ),
          ),
        ),
      );
      return {
        name: worker.name,
        destination: worker.destination,
        identityFile: worker.identityFile,
        port: worker.port,
        root: worker.root,
        gateway,
      } satisfies SshWorkerAddress;
    }),
  );
});

/**
 * The full engine composition for a local orchestrator driving SSH Workers;
 * brains are the instance roster checked at startup, and `options` addresses
 * each Worker's machine (`sshWorkerAddressesOf(config)` for the ones
 * `usine.yaml` declares). The caller provides the `CredentialProvider` that
 * mints each Attempt's single-repository token, the `TriggerCondition` that
 * re-checks queued Events, and the `AttemptRuntime` that runs each Attempt's
 * Pi parent in this process, built before the engine so durable storage is
 * resumed before Run recovery. Gateway admin APIs are called with `fetch`.
 */
export const layer = (
  instanceDirectory: InstanceDirectory,
  config: UsineConfig,
  brains: ReadonlyArray<BrainSpec>,
  options: SshExecutorOptions,
) => {
  const executor = sshExecutorLayer(options).pipe(
    Layer.provide(NodeServices.layer),
    Layer.provide(FetchHttpClient.layer),
  );
  const stepExecutor = stepExecutorLayer(config, brains).pipe(Layer.provide(executor));
  return localEngineLayer(instanceDirectory).pipe(Layer.provide(stepExecutor));
};
