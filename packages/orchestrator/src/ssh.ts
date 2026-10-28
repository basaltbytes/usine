import type { RunDatabase } from "@usine/engine/database";
import type { EnginePersistenceError } from "@usine/engine/engine";
import { NodeServices } from "@effect/platform-node";
import type { SshWorker, UsineConfig, Worker as ConfigWorker } from "@usine/config/factory";
import type { BrainSpec } from "@usine/core/agent/brain";
import type { InstanceDirectory } from "@usine/core/instance";
import { layer as localEngineLayer, localSqliteLayer } from "@usine/engine/local-sqlite";
import { WorkerCapabilityError, WorkerMachines } from "@usine/executor";
import {
  layer as sshExecutorLayer,
  type SshExecutorOptions,
  type SshWorkerAddress,
  type SshWorkerMachine,
  sshWorkerRecordsFor,
  SshWorkers,
} from "@usine/executor/ssh";
import { Config, ConfigProvider, Effect, Layer, Option } from "effect";
import { sshHttpClientLayer } from "./http-client.ts";
import { type StepExecutorOptions, stepExecutorLayer } from "./scheduler/scheduler.ts";

/** Returns where the SSH executor records how to reach each long-lived SSH Worker's machine. */
export const sshWorkerRecordsDirectory = (instanceDirectory: InstanceDirectory): string =>
  `${instanceDirectory}/.usine/ssh-workers`;

/**
 * Returns the layer that `make` builds with a `StepExecutor.discard` that removes the Codex homes
 * of the discarded Attempts on an SSH Worker whose machine `sshWorkerRecordsDirectory` records.
 * Every executor kind uses it, since `usine.yaml` can replace the SSH Workers with Workers of
 * another kind.
 */
export const withSshWorkerDiscard = <A, E, R>(
  instanceDirectory: InstanceDirectory,
  make: (discard: NonNullable<StepExecutorOptions["discard"]>) => Layer.Layer<A, E, R>,
) =>
  Layer.unwrap(
    Effect.map(sshWorkerRecordsFor(sshWorkerRecordsDirectory(instanceDirectory)), ({ discard }) =>
      make(discard),
    ),
  ).pipe(Layer.provide(NodeServices.layer));

/** Returns the SSH Workers that `usine.yaml` declares, in declared order. */
export const sshWorkersOf = (config: UsineConfig): ReadonlyArray<SshWorker> =>
  config.workers.filter((worker): worker is SshWorker => worker.kind === "ssh");

/**
 * Returns the message for a secret of an SSH Worker that the orchestrator's environment lacks:
 * `secret` names it, such as `gateway admin token`, and `variable` is its variable.
 */
type MissingSecret = (secret: string, variable: string, key: string) => string;

/** Returns the variable named `variable` from the orchestrator's environment. */
const secretFrom = (
  worker: SshWorker,
  capability: "gateway" | "provider" | "harness-login",
  variable: string,
  message: string,
) =>
  Config.Redacted(variable).pipe(
    Effect.mapError(
      (cause) =>
        new WorkerCapabilityError({
          worker: worker.name,
          capability,
          message,
          cause,
        }),
    ),
  );

/**
 * Returns how the executor finds `worker`'s machines: its destination, or its provisioner with
 * the provider token and API keys read from their variables.
 */
const sshWorkerMachineOf = (worker: SshWorker, missing: MissingSecret) =>
  Effect.gen(function* () {
    if (Option.isNone(worker.provisioner)) {
      if (Option.isNone(worker.destination))
        return yield* Effect.die(new Error(`SSH worker "${worker.name}" has no destination`));
      return { _tag: "Fixed", destination: worker.destination.value } satisfies SshWorkerMachine;
    }
    const settings = worker.provisioner.value;
    const token = yield* secretFrom(
      worker,
      "provider",
      settings.tokenEnv,
      missing(`${settings.provider} API token`, settings.tokenEnv, "provisioner.token_env"),
    );
    const apiKey = (provider: "anthropic" | "openai", label: string) =>
      Effect.transposeOption(
        Option.map(settings.apiKeys[provider], (variable) =>
          secretFrom(
            worker,
            "harness-login",
            variable,
            missing(label, variable, `provisioner.api_keys.${provider}`),
          ),
        ),
      );
    const apiKeys = {
      anthropic: yield* apiKey("anthropic", "Anthropic API key"),
      openai: yield* apiKey("openai", "OpenAI API key"),
    };
    switch (settings.provider) {
      case "hetzner":
        return {
          _tag: "Provisioned",
          provisioner: {
            provider: "hetzner",
            token,
            serverType: settings.serverType,
            location: settings.location,
            image: settings.image,
            network: settings.network,
            firewall: settings.firewall,
            sshKey: settings.sshKey,
            sshUser: settings.sshUser,
            labels: settings.labels,
            apiKeys,
          },
        } satisfies SshWorkerMachine;
      case "boat":
        return {
          _tag: "Provisioned",
          provisioner: {
            provider: "boat",
            token,
            size: settings.size,
            apiKeys,
            snapshot: settings.snapshot,
            tailnet: yield* Effect.transposeOption(
              Option.map(settings.tailnet, (tailnet) =>
                Effect.gen(function* () {
                  const read = (variable: string, field: string) =>
                    secretFrom(
                      worker,
                      "gateway",
                      variable,
                      missing("Tailscale OAuth client", variable, `provisioner.tailnet.${field}`),
                    );
                  return {
                    gatewayAddress: tailnet.gatewayAddress,
                    clientId: yield* read(tailnet.clientIdEnv, "client_id_env"),
                    clientSecret: yield* read(tailnet.clientSecretEnv, "client_secret_env"),
                  };
                }),
              ),
            ),
          },
        } satisfies SshWorkerMachine;
    }
  });

/**
 * Returns how the executor connects to `worker`, reading the Gateway admin token from
 * `admin_token_env` and a provisioner's token and API keys from their variables. Fails with a
 * capability error if a variable is unset.
 */
const sshWorkerAddressOf = (worker: SshWorker, missing: MissingSecret) =>
  Effect.gen(function* () {
    const gateway = yield* Effect.transposeOption(
      Option.map(worker.gateway, (settings) =>
        Effect.gen(function* () {
          const adminToken = yield* Config.Redacted(settings.adminTokenEnv);
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
                message: missing("gateway admin token", settings.adminTokenEnv, "admin_token_env"),
                cause,
              }),
          ),
        ),
      ),
    );
    return {
      name: worker.name,
      machine: yield* sshWorkerMachineOf(worker, missing),
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
 * Returns how the executor connects to each declared SSH Worker, reading Gateway admin tokens and
 * provisioner tokens and API keys at startup. If a variable is unset, fails with a capability
 * error that names it.
 */
export const sshWorkerAddressesOf = Effect.fn("Orchestrator.sshWorkerAddressesOf")(function* (
  config: UsineConfig,
) {
  return yield* Effect.forEach(sshWorkersOf(config), (worker) =>
    sshWorkerAddressOf(
      worker,
      (secret, variable) =>
        `The ${secret} for SSH worker "${worker.name}" is missing. Set ${variable} in the orchestrator's environment.`,
    ),
  );
});

/**
 * Provides the scheduler over the SSH executor, so reloads can resize, add, and remove SSH Workers.
 * A reload that adds a Worker fails with a `gateway` capability error if its `admin_token_env`
 * variable is unset. `options.discard` is `StepExecutor.discard`.
 */
export const sshStepExecutorLayer = (
  config: UsineConfig,
  brains: ReadonlyArray<BrainSpec>,
  options: Pick<StepExecutorOptions, "discard"> = {},
) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const machines = yield* SshWorkers;
      const provisioned = yield* Effect.serviceOption(WorkerMachines);
      const environment = yield* ConfigProvider.ConfigProvider;
      const add = Effect.fn("Orchestrator.addSshWorker")(function* (worker: ConfigWorker) {
        yield* Effect.annotateCurrentSpan({ worker: worker.name });
        if (worker.kind !== "ssh")
          return yield* Effect.die(
            new Error(`The SSH executor cannot run worker "${worker.name}" of kind ${worker.kind}`),
          );
        const address = yield* sshWorkerAddressOf(
          worker,
          (secret, variable, key) =>
            `The ${secret} for SSH worker "${worker.name}" is missing: ${variable} is not set in the orchestrator's environment. usine up reads only the variables that were set when it started. Set ${variable} and restart usine up, or set ${key} to a variable that usine up already has.`,
        ).pipe(Effect.provideService(ConfigProvider.ConfigProvider, environment));
        yield* machines.addWorker(address);
      });
      return stepExecutorLayer(config, brains, {
        ...options,
        workers: { add, remove: machines.removeWorker },
        ...Option.match(provisioned, { onNone: () => ({}), onSome: (machines) => ({ machines }) }),
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
  database: Layer.Layer<RunDatabase, EnginePersistenceError> = localSqliteLayer(instanceDirectory),
) => {
  const executor = sshExecutorLayer(options).pipe(
    Layer.provide(NodeServices.layer),
    Layer.provide(sshHttpClientLayer),
  );
  const stepExecutor = withSshWorkerDiscard(instanceDirectory, (discard) =>
    sshStepExecutorLayer(config, brains, { discard }),
  ).pipe(Layer.provide(executor));
  return localEngineLayer(instanceDirectory, database).pipe(Layer.provideMerge(stepExecutor));
};
