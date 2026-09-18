import type { BrainSpec } from "@usine/core/agent/brain";
import { NodeServices } from "@effect/platform-node";
import type { UsineConfig } from "@usine/config/factory";
import type { InstanceDirectory } from "@usine/core/instance";
import { layer as exeDevExecutorLayer } from "@usine/executor/exe-dev";
import { CredentialGrantMinutes, type ExeDevExecutorOptions } from "@usine/executor/exe-dev";
import { layer as localEngineLayer } from "@usine/engine/local-sqlite";
import { Layer, Option } from "effect";
import { stepExecutorLayer } from "./scheduler.ts";

/** The full engine composition for a local orchestrator driving exe.dev Workers; brains are the instance roster checked at startup. The caller provides the `TriggerCondition` that re-checks queued Events. */
export const layer = (
  instanceDirectory: InstanceDirectory,
  config: UsineConfig,
  brains: ReadonlyArray<BrainSpec>,
  options: ExeDevExecutorOptions,
) => {
  // Without a wall-clock ceiling the executor's own grant default applies.
  const credentialGrantMinutes =
    options.credentialGrantMinutes ??
    Option.getOrUndefined(
      Option.map(config.settings.maxAttemptMinutes, (minutes) =>
        CredentialGrantMinutes.make(minutes + 5),
      ),
    );
  const executor = exeDevExecutorLayer(
    credentialGrantMinutes === undefined ? options : { ...options, credentialGrantMinutes },
  ).pipe(Layer.provide(NodeServices.layer));
  const stepExecutor = stepExecutorLayer(config, brains).pipe(Layer.provide(executor));
  return localEngineLayer(instanceDirectory).pipe(Layer.provide(stepExecutor));
};
