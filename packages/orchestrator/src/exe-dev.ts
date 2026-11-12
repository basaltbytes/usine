import type { BrainSpec } from "@usine/core/agent/brain";
import { NodeServices } from "@effect/platform-node";
import type { UsineConfig } from "@usine/config/factory";
import type { InstanceDirectory } from "@usine/core/instance";
import { layer as exeDevExecutorLayer, type ExeDevExecutorOptions } from "@usine/executor/exe-dev";
import type { RunDatabase, TranscriptCodec } from "@usine/engine/database";
import type { EnginePersistenceError } from "@usine/engine/engine";
import { layer as localEngineLayer, localSqliteLayer } from "@usine/engine/local-sqlite";
import type { StepOutputStore } from "@usine/engine/step-outputs";
import { Layer } from "effect";
import { stepExecutorLayer } from "./scheduler/scheduler.ts";
import { withSshWorkerDiscard } from "./ssh.ts";

/**
 * Provides the full engine and `WorkerStatus` for exe.dev Workers. Requires `GitHubApp`,
 * `TriggerCondition`, `CompletionCheck`, `AttemptRuntime` (built before the engine), `Harnesses`, and
 * `CurrentInstance`.
 */
export const layer = (
  instanceDirectory: InstanceDirectory,
  config: UsineConfig,
  brains: ReadonlyArray<BrainSpec>,
  options: ExeDevExecutorOptions,
  database: Layer.Layer<
    RunDatabase | StepOutputStore | TranscriptCodec,
    EnginePersistenceError
  > = localSqliteLayer(instanceDirectory),
) => {
  const executor = exeDevExecutorLayer(options).pipe(Layer.provide(NodeServices.layer));
  // Discarding leftovers still removes the Codex homes on an SSH Worker that `usine.yaml` dropped.
  const stepExecutor = withSshWorkerDiscard(instanceDirectory, (discard) =>
    stepExecutorLayer(config, brains, { discard }),
  ).pipe(Layer.provide(executor));
  return localEngineLayer(instanceDirectory, database).pipe(Layer.provideMerge(stepExecutor));
};
