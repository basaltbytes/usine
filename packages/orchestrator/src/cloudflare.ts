import type { RunDatabase } from "@usine/engine/database";
import type { EnginePersistenceError } from "@usine/engine/engine";
import { NodeServices } from "@effect/platform-node";
import type { CloudflareWorker, UsineConfig, Worker as ConfigWorker } from "@usine/config/factory";
import type { BrainSpec } from "@usine/core/agent/brain";
import type { WorkerName } from "@usine/core/worker";
import type { InstanceDirectory } from "@usine/core/instance";
import { WorkerCapabilityError } from "@usine/executor";
import {
  CloudflareWorkers,
  type CloudflareExecutorOptions,
  type CloudflareWorkerAddress,
  layer as cloudflareExecutorLayer,
} from "@usine/executor/cloudflare";
import { layer as localEngineLayer, localSqliteLayer } from "@usine/engine/local-sqlite";
import { Config, ConfigProvider, Effect, Layer } from "effect";
import { externalHttpClientLayer } from "./http-client.ts";
import {
  stepExecutorLayer,
  type StepExecutorOptions,
  type WorkerRemoval,
} from "./scheduler/scheduler.ts";
import { workersChange } from "./current-instance/changes.ts";
import { withSshWorkerDiscard } from "./ssh.ts";

/** Returns the Cloudflare Workers that `usine.yaml` declares, in declared order. */
export const cloudflareWorkersOf = (config: UsineConfig): ReadonlyArray<CloudflareWorker> =>
  config.workers.filter((worker): worker is CloudflareWorker => worker.kind === "cloudflare");

/**
 * Returns how the executor reaches `worker`, reading its Access service token and provider keys
 * from the orchestrator's environment. Fails with a `credentials` capability error naming the
 * first unset variable.
 */
const cloudflareWorkerAddressOf = (worker: CloudflareWorker) => {
  const variable = (name: string) =>
    Config.Redacted(name).pipe(
      Effect.mapError(
        (cause) =>
          new WorkerCapabilityError({
            worker: worker.name,
            capability: "credentials",
            message: `The orchestrator's environment has no ${name}, which cloudflare worker "${worker.name}" names in usine.yaml. Set it and restart usine up.`,
            cause,
          }),
      ),
    );
  return Effect.gen(function* () {
    return {
      name: worker.name,
      workerUrl: worker.workerUrl,
      accessClientId: yield* variable(worker.accessClientIdEnv),
      accessClientSecret: yield* variable(worker.accessClientSecretEnv),
      image: worker.image,
      instanceType: worker.instanceType,
      providers: yield* Effect.forEach(worker.llmProviders, ({ provider, apiKeyEnv }) =>
        Effect.map(variable(apiKeyEnv), (apiKey) => ({ provider, apiKey })),
      ),
    } satisfies CloudflareWorkerAddress;
  });
};

/**
 * Returns how the executor reaches each declared Cloudflare Worker, reading the Access service
 * tokens and provider keys at startup.
 */
export const cloudflareWorkerAddressesOf = Effect.fn("Orchestrator.cloudflareWorkerAddressesOf")(
  function* (config: UsineConfig) {
    return yield* Effect.forEach(cloudflareWorkersOf(config), cloudflareWorkerAddressOf);
  },
);

/**
 * Provides the full engine and `WorkerStatus` for Cloudflare Workers. The executor reads its
 * workers' secrets when a revision adds a worker; existing clients remain unchanged.
 * Requires `CredentialProvider`, `GitHubApp`, `TriggerCondition`, `AttemptRuntime` (built before
 * the engine), `ClaudeLoginLock`, and `CurrentInstance`.
 */
export const layer = (
  instanceDirectory: InstanceDirectory,
  config: UsineConfig,
  brains: ReadonlyArray<BrainSpec>,
  options: CloudflareExecutorOptions,
  database: Layer.Layer<RunDatabase, EnginePersistenceError> = localSqliteLayer(instanceDirectory),
) => {
  const executor = cloudflareExecutorLayer(options).pipe(
    Layer.provide(NodeServices.layer),
    Layer.provide(externalHttpClientLayer),
  );
  const stepExecutor = withSshWorkerDiscard(instanceDirectory, (discard) =>
    cloudflareStepExecutorLayer(config, brains, {
      discard,
      initializedWorkers: options.workers.map(({ name }) => name),
    }),
  ).pipe(Layer.provide(executor));
  return localEngineLayer(instanceDirectory, database).pipe(Layer.provideMerge(stepExecutor));
};

/**
 * Resolves credentials and registers a client once for each added Cloudflare worker. A worker
 * that the scheduler accepted keeps its client for the life of the process; a worker whose
 * addition was refused before any acceptance loses its client, so a corrected revision can add it.
 */
export const cloudflareStepExecutorLayer = (
  config: UsineConfig,
  brains: ReadonlyArray<BrainSpec>,
  options: Pick<StepExecutorOptions, "discard"> & {
    readonly initializedWorkers?: ReadonlyArray<WorkerName>;
  } = {},
) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const workers = yield* CloudflareWorkers;
      const environment = yield* ConfigProvider.ConfigProvider;
      const initialized = new Map(
        config.workers
          .filter(({ name }) => options.initializedWorkers?.includes(name))
          .map((worker) => [worker.name, worker]),
      );
      const add = Effect.fn("Orchestrator.addCloudflareWorker")(function* (worker: ConfigWorker) {
        yield* Effect.annotateCurrentSpan({ worker: worker.name });
        if (worker.kind !== "cloudflare")
          return yield* Effect.die(new Error(`Unexpected worker kind ${worker.kind}`));
        const previous = initialized.get(worker.name);
        if (previous !== undefined) {
          const { restart } = workersChange([previous], [worker]);
          if (restart.length > 0) {
            yield* Effect.logWarning(
              "Refused a changed Cloudflare connection already initialized",
              {
                worker: worker.name,
                fields: restart.map(({ field }) => field),
              },
            );
            return yield* new WorkerCapabilityError({
              worker: worker.name,
              capability: "machine",
              message: `Restart the orchestrator to change the connection of Cloudflare worker "${worker.name}"; retained attempts keep their machine`,
              cause: restart,
            });
          }
          yield* Effect.logDebug("Cloudflare worker credentials are already initialized", {
            worker: worker.name,
          });
          return;
        }
        const address = yield* cloudflareWorkerAddressOf(worker).pipe(
          Effect.provideService(ConfigProvider.ConfigProvider, environment),
        );
        yield* workers.addWorker(address);
        initialized.set(worker.name, worker);
      });
      const remove = Effect.fn("Orchestrator.removeCloudflareWorker")(function* (
        worker: WorkerName,
        removal: WorkerRemoval,
      ) {
        yield* Effect.annotateCurrentSpan({ worker, removal });
        if (removal === "Removed") {
          yield* Effect.logDebug(
            "The Cloudflare worker keeps its client, because the scheduler accepted it",
            { worker, removal },
          );
          return;
        }
        yield* workers.removeWorker(worker);
        initialized.delete(worker);
        yield* Effect.logInfo(
          "Released the client of a Cloudflare worker whose addition was refused",
          { worker },
        );
      });
      return stepExecutorLayer(config, brains, {
        ...options,
        workers: { add, remove },
      });
    }),
  );
