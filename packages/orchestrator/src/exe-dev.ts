import type { BrainSpec } from "@usine/core/agent/brain";
import { NodeServices } from "@effect/platform-node";
import type { UsineConfig } from "@usine/config/factory";
import type { InstanceDirectory } from "@usine/core/instance";
import { layer as exeDevExecutorLayer } from "@usine/executor/exe-dev";
import { CredentialGrantMinutes, type ExeDevExecutorOptions } from "@usine/executor/exe-dev";
import { layer as localEngineLayer } from "@usine/engine/local-sqlite";
import { Layer, Option } from "effect";
import { stepExecutorLayer } from "./scheduler.ts";

/** The full engine composition for a local orchestrator driving exe.dev Workers; brains are the instance roster checked at startup. */
export const layer = (
  instanceDirectory: InstanceDirectory,
  config: UsineConfig,
  brains: ReadonlyArray<BrainSpec>,
  options: ExeDevExecutorOptions,
) => {
  // Without a wall-clock ceiling the executor's own grant default applies.
  const executorOptions =
    options.credentialGrantMinutes === undefined
      ? Option.match(config.settings.maxAttemptMinutes, {
          onNone: () => options,
          onSome: (minutes) => ({
            ...options,
            credentialGrantMinutes: CredentialGrantMinutes.make(minutes + 5),
          }),
        })
      : options;
  const executor = exeDevExecutorLayer(executorOptions).pipe(Layer.provide(NodeServices.layer));
  const stepExecutor = stepExecutorLayer(config, brains).pipe(Layer.provide(executor));
  return localEngineLayer(instanceDirectory).pipe(Layer.provide(stepExecutor));
};
