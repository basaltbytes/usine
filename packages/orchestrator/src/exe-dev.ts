import { NodeServices } from "@effect/platform-node";
import type { UsineConfig } from "@usine/config";
import type { Instance } from "@usine/core";
import {
  CredentialGrantMinutes,
  layer as exeDevExecutorLayer,
  type ExeDevExecutorOptions,
} from "@usine/executor/exe-dev";
import { layer as localEngineLayer } from "@usine/engine/local-sqlite";
import { Layer } from "effect";
import { stepExecutorLayer } from "./scheduler.ts";

/** Complete local-orchestrator / exe.dev-Worker engine composition. */
export const layer = (
  instanceDirectory: Instance.Directory,
  config: UsineConfig,
  options: ExeDevExecutorOptions,
) => {
  const executor = exeDevExecutorLayer({
    ...options,
    credentialGrantMinutes:
      options.credentialGrantMinutes ??
      CredentialGrantMinutes.make(config.settings.maxAttemptMinutes + 5),
  }).pipe(Layer.provide(NodeServices.layer));
  const stepExecutor = stepExecutorLayer(config).pipe(Layer.provide(executor));
  return localEngineLayer(instanceDirectory).pipe(Layer.provide(stepExecutor));
};
