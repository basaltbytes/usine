import { NodeServices } from "@effect/platform-node";
import type { SshWorker, UsineConfig } from "@usine/config/factory";
import type { BrainSpec } from "@usine/core/agent/brain";
import type { InstanceDirectory } from "@usine/core/instance";
import { layer as localEngineLayer } from "@usine/engine/local-sqlite";
import { layer as sshExecutorLayer, type SshExecutorOptions } from "@usine/executor/ssh";
import { Layer } from "effect";
import { stepExecutorLayer } from "./scheduler.ts";

/** The SSH Workers `usine.yaml` declares, in their declared order. */
export const sshWorkersOf = (config: UsineConfig): ReadonlyArray<SshWorker> =>
  config.workers.filter((worker): worker is SshWorker => worker.kind === "ssh");

/**
 * The full engine composition for a local orchestrator driving SSH Workers;
 * brains are the instance roster checked at startup, and `options` addresses
 * each Worker's machine (`sshWorkersOf(config)` for the ones `usine.yaml`
 * declares). The caller provides the `CredentialProvider` that mints each
 * Attempt's single-repository token, the `TriggerCondition` that re-checks
 * queued Events, and the `AttemptRuntime` that runs each Attempt's Pi parent
 * in this process, built before the engine so durable storage is resumed
 * before Run recovery.
 */
export const layer = (
  instanceDirectory: InstanceDirectory,
  config: UsineConfig,
  brains: ReadonlyArray<BrainSpec>,
  options: SshExecutorOptions,
) => {
  const executor = sshExecutorLayer(options).pipe(Layer.provide(NodeServices.layer));
  const stepExecutor = stepExecutorLayer(config, brains).pipe(Layer.provide(executor));
  return localEngineLayer(instanceDirectory).pipe(Layer.provide(stepExecutor));
};
