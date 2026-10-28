import type { RunDatabase } from "@usine/engine/database";
import type { EnginePersistenceError } from "@usine/engine/engine";
import type { BrainSpec } from "@usine/core/agent/brain";
import { NodeServices } from "@effect/platform-node";
import type { UsineConfig } from "@usine/config/factory";
import type { InstanceDirectory } from "@usine/core/instance";
import { layer as localExecutorLayer, type LocalExecutorOptions } from "@usine/executor/local";
import { layer as localEngineLayer, localSqliteLayer } from "@usine/engine/local-sqlite";
import { Layer } from "effect";
import { stepExecutorLayer } from "./scheduler.ts";
import { withSshWorkerDiscard } from "./ssh.ts";

/**
 * Provides the full engine and `WorkerStatus` for local Workers. Requires the credential provider,
 * `GitHubApp`, `TriggerCondition`, `AttemptRuntime`, `ClaudeLoginLock`, and `CurrentInstance`.
 */
export const layer = (
  instanceDirectory: InstanceDirectory,
  config: UsineConfig,
  brains: ReadonlyArray<BrainSpec>,
  options: Omit<LocalExecutorOptions, "instanceDirectory">,
  database: Layer.Layer<RunDatabase, EnginePersistenceError> = localSqliteLayer(instanceDirectory),
) => {
  const executor = localExecutorLayer({ ...options, instanceDirectory }).pipe(
    Layer.provide(NodeServices.layer),
  );
  // Discarding leftovers still removes the Codex homes on an SSH Worker that `usine.yaml` dropped.
  const stepExecutor = withSshWorkerDiscard(instanceDirectory, (discard) =>
    stepExecutorLayer(config, brains, { discard }),
  ).pipe(Layer.provide(executor));
  return localEngineLayer(instanceDirectory, database).pipe(Layer.provideMerge(stepExecutor));
};
