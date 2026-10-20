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
import { FetchHttpClient } from "effect/unstable/http";
import { stepExecutorLayer } from "./scheduler.ts";

/** The SSH Workers `usine.yaml` declares, in their declared order. */
export const sshWorkersOf = (config: UsineConfig): ReadonlyArray<SshWorker> =>
  config.workers.filter((worker): worker is SshWorker => worker.kind === "ssh");

/**
 * How the executor reaches `worker`, with its Gateway's admin token read from
 * the variable `admin_token_env` names. An unset variable fails with a
 * `gateway` capability error whose message `missing` writes from the
 * variable's name.
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
    } satisfies SshWorkerAddress;
  });

/**
 * How the executor reaches each SSH Worker `usine.yaml` declares, in their
 * declared order. The admin token of a Worker's Gateway is read here, at
 * startup, from the environment variable its `admin_token_env` names; an
 * unset variable fails startup with a `gateway` capability error naming the
 * Worker and the variable.
 */
export const sshWorkerAddressesOf = Effect.fn("Orchestrator.sshWorkerAddressesOf")(function* (
  config: UsineConfig,
) {
  return yield* Effect.forEach(sshWorkersOf(config), (worker) =>
    sshWorkerAddressOf(
      worker,
      (variable) =>
        `SSH Worker ${worker.name}'s Gateway admin token is missing: set ${variable} in the orchestrator's environment`,
    ),
  );
});

/**
 * The scheduler over the SSH executor and its `SshWorkers`, so a reload can
 * resize, add, and remove SSH Workers. A Worker the reload adds joins the
 * executor before its preflight, with its Gateway's admin token read then,
 * through the `ConfigProvider` this layer is built with, from the variable
 * its `admin_token_env` names. An unset variable refuses the reload with a
 * `gateway` capability error that names it: a running process does not see
 * variables set after it started. A removed Worker leaves the executor once
 * its last Attempt ends, and so does an added one whose preflight fails.
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
            new Error(`The SSH executor cannot run Worker ${worker.name} of kind ${worker.kind}`),
          );
        const address = yield* sshWorkerAddressOf(
          worker,
          (variable) =>
            `SSH Worker ${worker.name}'s Gateway admin token is missing: ${variable} is not set in the orchestrator's environment. A running process does not see variables set after it started, so set ${variable} and restart usine up, or set admin_token_env to a variable usine up already has`,
        ).pipe(Effect.provideService(ConfigProvider.ConfigProvider, environment));
        yield* machines.addWorker(address);
      });
      return stepExecutorLayer(config, brains, {
        workers: { add, remove: machines.removeWorker },
      });
    }),
  );

/**
 * The full engine composition for a local orchestrator driving SSH Workers;
 * brains are the instance roster checked at startup, and `options` addresses
 * each Worker's machine (`sshWorkerAddressesOf(config)` for the ones
 * `usine.yaml` declares). The caller provides the `CredentialProvider` that
 * mints each Attempt's single-repository token, the `GitHubApp` whose bot
 * login each Attempt records, the `TriggerCondition` that
 * re-checks queued Events, the `AttemptRuntime` that runs each Attempt's Pi
 * parent in this process, built before the engine so durable storage is
 * resumed before Run recovery, and the `CurrentInstance` whose settings each
 * Attempt reads. Gateway admin APIs are called with `fetch`. A reload can
 * resize, add, and remove SSH Workers (`sshStepExecutorLayer`). It also
 * provides the `WorkerStatus` of its Workers.
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
  const stepExecutor = sshStepExecutorLayer(config, brains).pipe(Layer.provide(executor));
  return localEngineLayer(instanceDirectory).pipe(Layer.provideMerge(stepExecutor));
};
