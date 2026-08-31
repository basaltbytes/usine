import { NodeServices } from "@effect/platform-node";
import type { UsineConfig } from "@usine/config";
import type { Instance } from "@usine/core";
import { layer as localExecutorLayer, type LocalExecutorOptions } from "@usine/executor/local";
import { layer as localEngineLayer } from "@usine/engine/local-sqlite";
import { executableCommand } from "@usine/run-host/executable";
import { Layer } from "effect";
import { stepExecutorLayer } from "./index.ts";

/** Complete local-worker engine composition. Credential sourcing stays caller-owned. */
export const layer = (
  instanceDirectory: Instance.Directory,
  config: UsineConfig,
  options: Omit<LocalExecutorOptions, "instanceDirectory" | "runHost"> &
    Partial<Pick<LocalExecutorOptions, "runHost">>,
) => {
  const executor = localExecutorLayer({
    runHost: options.runHost ?? executableCommand(),
    ...options,
    instanceDirectory,
  }).pipe(Layer.provide(NodeServices.layer));
  const stepExecutor = stepExecutorLayer(config).pipe(Layer.provide(executor));
  return localEngineLayer(instanceDirectory).pipe(Layer.provide(stepExecutor));
};
