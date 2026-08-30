import { NodeServices } from "@effect/platform-node";
import type { UsineConfig } from "@usine/config";
import { layer as localExecutorLayer, type LocalExecutorOptions } from "@usine/executor/local";
import type { InstanceDirectory } from "@usine/engine";
import { layer as localEngineLayer } from "@usine/engine/local-sqlite";
import { Layer } from "effect";
import { stepExecutorLayer } from "./index.ts";

/** Complete local-worker engine composition. Credential sourcing stays caller-owned. */
export const layer = (
  instanceDirectory: InstanceDirectory,
  config: UsineConfig,
  options: Omit<LocalExecutorOptions, "instanceDirectory">,
) => {
  const executor = localExecutorLayer({ ...options, instanceDirectory }).pipe(
    Layer.provide(NodeServices.layer),
  );
  const stepExecutor = stepExecutorLayer(config).pipe(Layer.provide(executor));
  return localEngineLayer(instanceDirectory).pipe(Layer.provide(stepExecutor));
};
