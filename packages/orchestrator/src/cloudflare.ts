import { NodeServices } from "@effect/platform-node";
import type { CloudflareWorker, UsineConfig } from "@usine/config/factory";
import type { BrainSpec } from "@usine/core/agent/brain";
import type { InstanceDirectory } from "@usine/core/instance";
import { ExecutorOperationError, WorkerCapabilityError } from "@usine/executor";
import {
  type CloudflareWorkerAddress,
  layer as cloudflareExecutorLayer,
} from "@usine/executor/cloudflare";
import { layer as localEngineLayer } from "@usine/engine/local-sqlite";
import { Config, Effect, Layer } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { stepExecutorLayer } from "./scheduler.ts";

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
    Config.redacted(name).pipe(
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
  workers: ReadonlyArray<CloudflareWorkerAddress>,
) => {
  const executor = cloudflareExecutorLayer({ workers }).pipe(
    Layer.provide(NodeServices.layer),
    Layer.provide(FetchHttpClient.layer),
  );
  const started = new Set(workers.map(({ name }) => name));
  const stepExecutor = stepExecutorLayer(config, brains, {
    workers: {
      add: (worker) =>
        started.has(worker.name)
          ? Effect.void
          : Effect.fail(
              new ExecutorOperationError({
                operation: "preflight",
                message: `A reload can't add cloudflare worker "${worker.name}", whose secrets usine up reads when it starts. Restart usine up to add it.`,
                cause: new Error(worker.name),
              }),
            ),
      remove: () => Effect.void,
    },
  }).pipe(Layer.provide(executor));
  return localEngineLayer(instanceDirectory).pipe(Layer.provideMerge(stepExecutor));
};
