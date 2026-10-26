import { BrainSpec } from "@usine/core/agent/brain";
import { NodeServices } from "@effect/platform-node";
import { ConfigParser } from "@usine/config/parser";
import type { InstanceDirectory, InstanceId } from "@usine/core/instance";
import { layer as durableAttemptRuntimeLayer } from "@usine/durable/live";
import { observationLayer as localObservationLayer } from "@usine/engine/local-sqlite";
import { claudeLoginLockLayer } from "@usine/executor";
import { MarcbachmannCelLayer } from "@usine/expression/marcbachmann-cel";
import { GitHubApp } from "@usine/github/github-app";
import { GitHubItemHistory } from "@usine/github/item-history";
import { GitHubItemWriter } from "@usine/github/item-writer";
import { GitHubLabelWriter } from "@usine/github/label-writer";
import { GitHubPolling } from "@usine/github/polling";
import { Effect, Layer } from "effect";
import { gitHubCredentialLayer } from "./credentials.ts";
import { CurrentInstance } from "./current-instance/current-instance.ts";
import { externalHttpClientLayer } from "./http-client.ts";
import { idleTriggersLayer } from "./idle-triggers.ts";
import { LabelReconciler } from "./label-reconciler.ts";
import { OperatorConfiguration } from "./operator/configuration.ts";
import { Operator, OperatorObservation } from "./operator/operator.ts";
import { Orchestrator } from "./orchestrator.ts";
import { PollingTriggers } from "./polling-triggers.ts";
import { ScheduleTriggers } from "./schedule-triggers.ts";
import { triggerConditionLayer } from "./trigger-condition.ts";
import { workerEngineLayer } from "./worker-engine.ts";
import { WorkerStatus } from "./worker-status.ts";

/**
 * Provides the read-only operator surface (observation, desk, and configuration) for when trigger
 * credentials aren't available yet. No Worker runs Attempts.
 */
export const operatorObservationLayer = (instanceDirectory: InstanceDirectory) =>
  Layer.mergeAll(OperatorObservation.layer, OperatorConfiguration.layer).pipe(
    Layer.provide(
      Layer.mergeAll(
        localObservationLayer(instanceDirectory),
        idleTriggersLayer,
        MarcbachmannCelLayer,
        WorkerStatus.idle,
      ),
    ),
  );

/**
 * Provides the full Node composition for one factory: trigger streams, the durable engine, Worker
 * execution, and the operator surface. Requires the GitHub credentials and `CurrentInstance`.
 */
export const runtimeLayer = (instanceDirectory: InstanceDirectory, instanceId: InstanceId) => {
  const app = GitHubApp.layer.pipe(
    Layer.provide(externalHttpClientLayer),
    Layer.provide(NodeServices.layer),
  );
  const credentials = gitHubCredentialLayer.pipe(Layer.provide(app));
  const polling = GitHubPolling.layer.pipe(
    Layer.provide(app),
    Layer.provide(externalHttpClientLayer),
    Layer.provide(NodeServices.layer),
  );
  const triggerCondition = triggerConditionLayer.pipe(
    Layer.provide(polling),
    Layer.provide(MarcbachmannCelLayer),
  );
  // One Claude login lock per Worker, shared by the executor's preflight and the Attempts' Claude
  // children.
  const attemptRuntime = durableAttemptRuntimeLayer(instanceDirectory).pipe(
    Layer.provideMerge(claudeLoginLockLayer),
    Layer.provide(NodeServices.layer),
  );
  const engine = Layer.unwrap(
    Effect.gen(function* () {
      const startup = yield* (yield* CurrentInstance).get;
      return workerEngineLayer(
        instanceDirectory,
        instanceId,
        startup.config,
        startup.agents.map(
          ({ harness, model, effort }) => new BrainSpec({ harness, model, effort }),
        ),
      );
    }),
  ).pipe(
    Layer.provide(credentials),
    Layer.provide(app),
    Layer.provide(triggerCondition),
    Layer.provide(attemptRuntime),
  );
  const itemWriter = GitHubItemWriter.layer.pipe(
    Layer.provide(app),
    Layer.provide(externalHttpClientLayer),
  );
  const itemHistory = GitHubItemHistory.layer.pipe(
    Layer.provide(app),
    Layer.provide(externalHttpClientLayer),
  );
  const labelWriter = GitHubLabelWriter.layer.pipe(
    Layer.provide(app),
    Layer.provide(externalHttpClientLayer),
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
  const services = Layer.mergeAll(
    Operator.layer,
    OperatorConfiguration.layer,
    Orchestrator.layer,
  ).pipe(Layer.provide(Layer.mergeAll(dependencies, triggers, itemHistory)));
  return Layer.mergeAll(dependencies, triggers, services);
};
