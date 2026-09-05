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

/** Complete local-worker engine composition. Credential sourcing stays caller-owned. */
export const layer = (
  instanceDirectory: InstanceDirectory,
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

/** Read-only local operator composition used while trigger credentials are unavailable. */
export const operatorObservationLayer = (instanceDirectory: InstanceDirectory) =>
  OperatorObservation.layer.pipe(
    Layer.provide(Layer.mergeAll(localObservationLayer(instanceDirectory), idleTriggersLayer)),
  );

/**
 * Complete Node composition for one loaded local factory. The caller still
 * owns GitHub credential sourcing; everything else — both trigger streams,
 * durable engine, worker execution, and operator surface — is included.
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
  const engine = layer(instanceDirectory, instance.config, options).pipe(
    Layer.provide(credentials),
  );
  const polling = GitHubPolling.layer.pipe(
    Layer.provide(app),
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(NodeServices.layer),
  );
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
