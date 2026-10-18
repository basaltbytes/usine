import type { BrainSpec } from "@usine/core/agent/brain";
import { NodeServices } from "@effect/platform-node";
import type { UsineConfig } from "@usine/config/factory";
import type { InstanceDirectory } from "@usine/core/instance";
import { layer as localExecutorLayer, type LocalExecutorOptions } from "@usine/executor/local";
import { layer as localEngineLayer } from "@usine/engine/local-sqlite";
import { Layer } from "effect";
import { stepExecutorLayer } from "./scheduler.ts";

/**
 * The full engine composition for local Workers. Supply the roster’s brains for
 * startup preflight and provide the credential provider, the `TriggerCondition`
 * that re-checks queued Events, the `AttemptRuntime` that runs each Attempt's
 * Pi parent in this process, and the `CurrentInstance` whose settings each
 * Attempt reads. The runtime is built first, so durable storage is open and
 * its tasks resumed before the engine recovers Runs.
 */
export const layer = (
  instanceDirectory: InstanceDirectory,
  config: UsineConfig,
  brains: ReadonlyArray<BrainSpec>,
  options: Omit<LocalExecutorOptions, "instanceDirectory">,
) => {
  const executor = localExecutorLayer({ ...options, instanceDirectory }).pipe(
    Layer.provide(NodeServices.layer),
  );
  const stepExecutor = stepExecutorLayer(config, brains).pipe(Layer.provide(executor));
  return localEngineLayer(instanceDirectory).pipe(Layer.provide(stepExecutor));
};
