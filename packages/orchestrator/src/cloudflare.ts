import type { RunDatabase } from "@usine/engine/database";
import type { EnginePersistenceError } from "@usine/engine/engine";
import { NodeServices } from "@effect/platform-node";
import type { CloudflareWorker, UsineConfig, Worker as ConfigWorker } from "@usine/config/factory";
import type { BrainSpec } from "@usine/core/agent/brain";
import type { WorkerName } from "@usine/core/worker";
import type { InstanceDirectory } from "@usine/core/instance";
import { ExecutorOperationError, WorkerCapabilityError } from "@usine/executor";
import {
  CloudflareWorkers,
  type CloudflareExecutorOptions,
  type CloudflareWorkerAddress,
  layer as cloudflareExecutorLayer,
} from "@usine/executor/cloudflare";
import { layer as localEngineLayer, localSqliteLayer } from "@usine/engine/local-sqlite";
import { Config, ConfigProvider, Effect, Layer } from "effect";
import { externalHttpClientLayer } from "./http-client.ts";
import { stepExecutorLayer } from "./scheduler/scheduler.ts";
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
 * Workers' secrets once, so a reload adds back only a Worker that `usine up` started with.
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
  const started = new Set(config.workers.map(({ name }) => name));
  // Discarding leftovers still removes the Codex homes on an SSH Worker that `usine.yaml` dropped.
  const stepExecutor = withSshWorkerDiscard(instanceDirectory, (discard) =>
    Layer.unwrap(
      Effect.gen(function* () {
        const workers = yield* CloudflareWorkers;
        const environment = yield* ConfigProvider.ConfigProvider;
        const initialized = new Set<WorkerName>(options.workers.map(({ name }) => name));
        const add = Effect.fn("Orchestrator.addCloudflareWorker")(function* (worker: ConfigWorker) {
          yield* Effect.annotateCurrentSpan({ worker: worker.name });
          if (!started.has(worker.name))
            return yield* new ExecutorOperationError({
              operation: "preflight",
              message: `A reload can't add cloudflare worker "${worker.name}", whose secrets usine up reads when it starts. Restart usine up to add it.`,
              cause: new Error(worker.name),
            });
          if (worker.kind !== "cloudflare")
            return yield* Effect.die(new Error(`Unexpected worker kind ${worker.kind}`));
          if (initialized.has(worker.name)) {
            yield* Effect.logDebug("Cloudflare worker credentials are already initialized", {
              worker: worker.name,
            });
            return;
          }
          const address = yield* cloudflareWorkerAddressOf(worker).pipe(
            Effect.provideService(ConfigProvider.ConfigProvider, environment),
          );
          yield* workers.addWorker(address);
          initialized.add(worker.name);
        });
        return stepExecutorLayer(config, brains, {
          discard,
          workers: { add, remove: () => Effect.void },
        });
      }),
    ),
  ).pipe(Layer.provide(executor));
  return localEngineLayer(instanceDirectory, database).pipe(Layer.provideMerge(stepExecutor));
};
