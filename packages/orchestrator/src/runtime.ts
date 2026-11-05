import type { StepOutputStore } from "@usine/engine/step-outputs";
import { GitHubChecks } from "@usine/github/checks";
import { CiMonitor } from "./ci.ts";
import { WebhookHealth } from "./webhooks.ts";
import type { RunDatabase, TranscriptCodec } from "@usine/engine/database";
import type { EnginePersistenceError } from "@usine/engine/engine";
import { AttentionAcknowledgements } from "@usine/engine/attention";
import { BrainSpec } from "@usine/core/agent/brain";
import { harnessesLive } from "@usine/agents/harness/node";
import { NodeServices } from "@effect/platform-node";
import { ConfigParser } from "@usine/config/parser";
import type { InstanceDirectory, InstanceId } from "@usine/core/instance";
import { layer as durableAttemptRuntimeLayer } from "@usine/durable/live";
import {
  observationLayer as localObservationLayer,
  localSqliteLayer,
} from "@usine/engine/local-sqlite";
import { hostLoginLockLayer } from "@usine/executor";
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
import { OperatorConfiguration } from "./operator/configuration/view.ts";
import { Operator, OperatorObservation } from "./operator/operator.ts";
import { Orchestrator } from "./orchestrator.ts";
import { PollingTriggers } from "./polling-triggers.ts";
import { ScheduleTriggers } from "./schedule-triggers.ts";
import { triggerConditionLayer } from "./trigger-condition.ts";
import { workerEngineLayer } from "./worker-engine.ts";
import { WorkerStatus } from "./worker-status.ts";

/**
 * Provides observation, configuration, and attention acknowledgements while trigger credentials
 * are unavailable. No worker runs attempts.
 */
export const operatorObservationLayer = (
  instanceDirectory: InstanceDirectory,
  database: Layer.Layer<
    RunDatabase | StepOutputStore | TranscriptCodec,
    EnginePersistenceError
  > = localSqliteLayer(instanceDirectory),
) =>
  Layer.mergeAll(
    OperatorObservation.layer,
    OperatorConfiguration.layer,
    Layer.effect(AttentionAcknowledgements, AttentionAcknowledgements),
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        localObservationLayer(instanceDirectory, database),
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
export const runtimeLayer = (
  instanceDirectory: InstanceDirectory,
  instanceId: InstanceId,
  database: Layer.Layer<
    RunDatabase | StepOutputStore | TranscriptCodec,
    EnginePersistenceError
  > = localSqliteLayer(instanceDirectory),
) => {
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
  // One Claude login lock per Worker, or per machine of a provisioned Worker, shared by the
  // executor's preflight and the Attempts' Claude children.
  const attemptRuntime = durableAttemptRuntimeLayer(instanceDirectory).pipe(
    Layer.provideMerge(harnessesLive),
    Layer.provideMerge(hostLoginLockLayer),
    Layer.provide(NodeServices.layer),
  );
  const engine = Layer.unwrap(
    Effect.gen(function* () {
      const startup = yield* (yield* CurrentInstance).get;
      return workerEngineLayer(
        instanceDirectory,
        instanceId,
        startup.config,
        startup.agents.map(({ harness, model, effort }) =>
          BrainSpec.make({ harness, model, effort }),
        ),
        database,
      );
    }),
  ).pipe(
    Layer.provide(credentials),
    Layer.provide(app),
    Layer.provide(triggerCondition),
    Layer.provide(attemptRuntime),
    Layer.provide(MarcbachmannCelLayer),
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
  const ci = CiMonitor.layer.pipe(
    Layer.provide(dependencies),
    Layer.provide(
      GitHubChecks.layer.pipe(Layer.provide(app), Layer.provide(externalHttpClientLayer)),
    ),
  );
  const triggers = Layer.mergeAll(PollingTriggers.layer, ScheduleTriggers.layer).pipe(
    Layer.provide(dependencies),
    Layer.provide(ci),
  );
  const services = Layer.mergeAll(
    Operator.layer,
    OperatorConfiguration.layer,
    Orchestrator.layer,
  ).pipe(Layer.provide(Layer.mergeAll(dependencies, triggers, itemHistory, app)));
  return Layer.mergeAll(dependencies, triggers, services, app, WebhookHealth.layer);
};
