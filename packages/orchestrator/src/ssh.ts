import { NodeServices } from "@effect/platform-node";
import type { SshWorker, UsineConfig, Worker as ConfigWorker } from "@usine/config/factory";
import type { BrainSpec } from "@usine/core/agent/brain";
import type { InstanceDirectory } from "@usine/core/instance";
import { layer as localEngineLayer } from "@usine/engine/local-sqlite";
import { WorkerCapabilityError } from "@usine/executor";
import {
  layer as sshExecutorLayer,
  type SshExecutorOptions,
  type SshWorkerAddress,
  SshWorkers,
} from "@usine/executor/ssh";
import { Config, ConfigProvider, Effect, Layer, Option } from "effect";
import { externalHttpClientLayer } from "./http-client.ts";
import { stepExecutorLayer } from "./scheduler.ts";

/** Returns the SSH Workers that `usine.yaml` declares, in declared order. */
export const sshWorkersOf = (config: UsineConfig): ReadonlyArray<SshWorker> =>
  config.workers.filter((worker): worker is SshWorker => worker.kind === "ssh");

/**
 * Returns how the executor connects to `worker`, reading the Gateway admin token from
 * `admin_token_env`. Fails with a `gateway` capability error if the variable is unset.
 */
const sshWorkerAddressOf = (worker: SshWorker, missing: (variable: string) => string) =>
  Effect.gen(function* () {
    const gateway = yield* Effect.transposeOption(
      Option.map(worker.gateway, (settings) =>
        Effect.gen(function* () {
          const adminToken = yield* Config.redacted(settings.adminTokenEnv);
          return {
            domain: settings.domain,
            destination: settings.destination,
            adminPort: settings.adminPort,
            adminToken,
            llmProviders: settings.llmProviders,
          };
        }).pipe(
          Effect.mapError(
            (cause) =>
              new WorkerCapabilityError({
                worker: worker.name,
                capability: "gateway",
                message: missing(settings.adminTokenEnv),
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
      container: {
        image: worker.container.image,
        cpus: worker.container.cpus,
        memoryMib: worker.container.memoryMib,
        pids: worker.container.pids,
      },
    } satisfies SshWorkerAddress;
  });

/**
 * Returns how the executor connects to each declared SSH Worker, reading Gateway admin tokens at
 * startup. If an `admin_token_env` variable is unset, fails with a `gateway` capability error.
 */
export const sshWorkerAddressesOf = Effect.fn("Orchestrator.sshWorkerAddressesOf")(function* (
  config: UsineConfig,
) {
  return yield* Effect.forEach(sshWorkersOf(config), (worker) =>
    sshWorkerAddressOf(
      worker,
      (variable) =>
        `The gateway admin token for SSH worker "${worker.name}" is missing. Set ${variable} in the orchestrator's environment.`,
    ),
  );
});

/**
 * Provides the scheduler over the SSH executor, so reloads can resize, add, and remove SSH Workers.
 * A reload that adds a Worker fails with a `gateway` capability error if its `admin_token_env`
 * variable is unset.
 */
export const sshStepExecutorLayer = (config: UsineConfig, brains: ReadonlyArray<BrainSpec>) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const machines = yield* SshWorkers;
      const environment = yield* ConfigProvider.ConfigProvider;
      const add = Effect.fn("Orchestrator.addSshWorker")(function* (worker: ConfigWorker) {
        yield* Effect.annotateCurrentSpan({ worker: worker.name });
        if (worker.kind !== "ssh")
          return yield* Effect.die(
            new Error(`The SSH executor cannot run worker "${worker.name}" of kind ${worker.kind}`),
          );
        const address = yield* sshWorkerAddressOf(
          worker,
          (variable) =>
            `The gateway admin token for SSH worker "${worker.name}" is missing: ${variable} is not set in the orchestrator's environment. usine up reads only the variables that were set when it started. Set ${variable} and restart usine up, or set admin_token_env to a variable that usine up already has.`,
        ).pipe(Effect.provideService(ConfigProvider.ConfigProvider, environment));
        yield* machines.addWorker(address);
      });
      return stepExecutorLayer(config, brains, {
        workers: { add, remove: machines.removeWorker },
      });
    }),
  );

/**
 * Provides the full engine and `WorkerStatus` for SSH Workers. Requires `CredentialProvider`,
 * `GitHubApp`, `TriggerCondition`, `AttemptRuntime` (built before the engine), `ClaudeLoginLock`,
 * and `CurrentInstance`.
 */
export const layer = (
  instanceDirectory: InstanceDirectory,
  config: UsineConfig,
  brains: ReadonlyArray<BrainSpec>,
  options: SshExecutorOptions,
) => {
  const executor = sshExecutorLayer(options).pipe(
    Layer.provide(NodeServices.layer),
    Layer.provide(externalHttpClientLayer),
  );
  const stepExecutor = sshStepExecutorLayer(config, brains).pipe(Layer.provide(executor));
  return localEngineLayer(instanceDirectory).pipe(Layer.provideMerge(stepExecutor));
};
