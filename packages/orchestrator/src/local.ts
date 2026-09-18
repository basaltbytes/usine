import { BrainSpec } from "@usine/core/agent/brain";
import { NodeServices } from "@effect/platform-node";
import type { LoadedInstance } from "@usine/config/instance";
import type { UsineConfig } from "@usine/config/factory";
import { ConfigParser } from "@usine/config/parser";
import type { InstanceDirectory } from "@usine/core/instance";
import { layer as localExecutorLayer, type LocalExecutorOptions } from "@usine/executor/local";
import {
  layer as localEngineLayer,
  observationLayer as localObservationLayer,
} from "@usine/engine/local-sqlite";
import { MarcbachmannCelLayer } from "@usine/expression/marcbachmann-cel";
import { GitHubApp } from "@usine/github/github-app";
import { GitHubItemWriter } from "@usine/github/item-writer";
import { GitHubLabelWriter } from "@usine/github/label-writer";
import { GitHubPolling } from "@usine/github/polling";
import { executableCommand } from "@usine/run-host/executable";
import { Layer } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { gitHubCredentialLayer } from "./credentials.ts";
import { idleTriggersLayer } from "./idle-triggers.ts";
import { LabelReconciler } from "./label-reconciler.ts";
import { Operator, OperatorObservation } from "./operator/operator.ts";
import { Orchestrator } from "./orchestrator.ts";
import { PollingTriggers } from "./polling-triggers.ts";
import { ScheduleTriggers } from "./schedule-triggers.ts";
import { stepExecutorLayer } from "./scheduler.ts";
import { triggerConditionLayer } from "./trigger-condition.ts";

/** The full engine composition for local Workers. Supply the roster’s brains for startup preflight and provide the credential provider and the `TriggerCondition` that re-checks queued Events. */
export const layer = (
  instanceDirectory: InstanceDirectory,
  config: UsineConfig,
  brains: ReadonlyArray<BrainSpec>,
  options: Omit<LocalExecutorOptions, "instanceDirectory" | "runHost"> &
    Partial<Pick<LocalExecutorOptions, "runHost">>,
) => {
  const executor = localExecutorLayer({
    runHost: options.runHost ?? executableCommand(),
    ...options,
    instanceDirectory,
  }).pipe(Layer.provide(NodeServices.layer));
  const stepExecutor = stepExecutorLayer(config, brains).pipe(Layer.provide(executor));
  return localEngineLayer(instanceDirectory).pipe(Layer.provide(stepExecutor));
};

/** A read-only operator composition for when trigger credentials are not available yet. */
export const operatorObservationLayer = (instanceDirectory: InstanceDirectory) =>
  OperatorObservation.layer.pipe(
    Layer.provide(Layer.mergeAll(localObservationLayer(instanceDirectory), idleTriggersLayer)),
  );

/**
 * The full Node composition for one loaded local factory: both trigger
 * streams, the durable engine, worker execution, and the operator surface.
 * The caller supplies the GitHub credentials.
 */
export const runtimeLayer = (
  instanceDirectory: InstanceDirectory,
  instance: LoadedInstance,
  options: Omit<LocalExecutorOptions, "instanceDirectory" | "runHost"> &
    Partial<Pick<LocalExecutorOptions, "runHost">>,
) => {
  const app = GitHubApp.layer.pipe(
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(NodeServices.layer),
  );
  const credentials = gitHubCredentialLayer(instance.config).pipe(Layer.provide(app));
  const polling = GitHubPolling.layer.pipe(
    Layer.provide(app),
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(NodeServices.layer),
  );
  const triggerCondition = triggerConditionLayer(instance).pipe(
    Layer.provide(polling),
    Layer.provide(MarcbachmannCelLayer),
  );
  const engine = layer(
    instanceDirectory,
    instance.config,
    instance.agents.map(({ harness, model, effort }) => new BrainSpec({ harness, model, effort })),
    options,
  ).pipe(Layer.provide(credentials), Layer.provide(triggerCondition));
  const itemWriter = GitHubItemWriter.layer.pipe(
    Layer.provide(app),
    Layer.provide(FetchHttpClient.layer),
  );
  const labelWriter = GitHubLabelWriter.layer.pipe(
    Layer.provide(app),
    Layer.provide(FetchHttpClient.layer),
  );
  const labelReconciler = LabelReconciler.layer.pipe(Layer.provide(labelWriter));
  const parser = ConfigParser.layer.pipe(Layer.provide(MarcbachmannCelLayer));
  const dependencies = Layer.mergeAll(
    engine,
    itemWriter,
    labelReconciler,
    MarcbachmannCelLayer,
    parser,
    polling,
  );
  const triggers = Layer.mergeAll(PollingTriggers.layer, ScheduleTriggers.layer).pipe(
    Layer.provide(dependencies),
  );
  const services = Layer.mergeAll(Operator.layer, Orchestrator.layer).pipe(
    Layer.provide(Layer.mergeAll(dependencies, triggers)),
  );
  return Layer.mergeAll(dependencies, triggers, services);
};
