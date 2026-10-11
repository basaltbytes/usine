import type { BrainSpec } from "@usine/core/agent/brain";
import { NodeServices } from "@effect/platform-node";
import type { UsineConfig } from "@usine/config/factory";
import type { InstanceDirectory } from "@usine/core/instance";
import { layer as exeDevExecutorLayer, type ExeDevExecutorOptions } from "@usine/executor/exe-dev";
import { layer as localEngineLayer } from "@usine/engine/local-sqlite";
import { Layer } from "effect";
import { stepExecutorLayer } from "./scheduler.ts";

/**
 * The full engine composition for a local orchestrator driving exe.dev
 * Workers; brains are the instance roster checked at startup. The caller
 * provides the `TriggerCondition` that re-checks queued Events and the
 * `AttemptRuntime` that runs each Attempt's Pi parent in this process, built
 * before the engine so durable storage is resumed before Run recovery.
 */
export const layer = (
  instanceDirectory: InstanceDirectory,
  config: UsineConfig,
  brains: ReadonlyArray<BrainSpec>,
  options: ExeDevExecutorOptions,
) => {
  const executor = exeDevExecutorLayer(options).pipe(Layer.provide(NodeServices.layer));
  const stepExecutor = stepExecutorLayer(config, brains).pipe(Layer.provide(executor));
  return localEngineLayer(instanceDirectory).pipe(Layer.provide(stepExecutor));
};
