import { completionCheckLayer } from "./completion-check.ts";
import { GitHubFiles } from "@usine/github/files";
import type { StepOutputStore } from "@usine/engine/step-outputs";
import type { CompletionCheck } from "@usine/engine/completion-check";
import type { TriggerCondition } from "@usine/engine/trigger-condition";
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
import type { SqlClient } from "effect/sql";
import { gitHubCredentialLayer } from "./credentials.ts";
import { parentAdmissionLayer } from "./current-instance/parents.ts";
import { CurrentInstance } from "./current-instance/current-instance.ts";
import { externalHttpClientLayer } from "./http-client.ts";
import { supervisorSandboxLayer } from "./supervisor-sandbox.ts";
import { idleTriggersLayer } from "./idle-triggers.ts";
import { LabelReconciler } from "./label-reconciler.ts";
import { OperatorConfiguration } from "./operator/configuration/view.ts";
import { Operator, OperatorObservation } from "./operator/operator.ts";
import { Orchestrator } from "./orchestrator.ts";
import { PollingTriggers } from "./polling-triggers.ts";
import { ScheduleTriggers } from "./schedule-triggers.ts";
import { triggerConditionLayer } from "./trigger-condition.ts";
import { workerEngineLayer } from "./worker-engine.ts";
import { parentModels } from "./parent-models.ts";
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
 * Provides the engine's checks of GitHub Items: the trigger recheck of queued Events and the
 * outcome label verification of successful Attempts. Requires `CurrentInstance`.
 */
export const engineItemChecksLayer = <E, R>(
  github: Layer.Layer<GitHubApp | GitHubItemHistory | GitHubPolling, E, R>,
): Layer.Layer<CompletionCheck | TriggerCondition, E, CurrentInstance | R> =>
  Layer.mergeAll(
    completionCheckLayer,
    triggerConditionLayer.pipe(Layer.provide(MarcbachmannCelLayer)),
  ).pipe(Layer.provide(github));

/**
 * Provides the full Node composition for one factory: trigger streams, the durable engine, Worker
 * execution, and the operator surface. Requires the GitHub credentials and `CurrentInstance`.
 */
export const runtimeLayer = (
  instanceDirectory: InstanceDirectory,
  instanceId: InstanceId,
  database: Layer.Layer<
    RunDatabase | StepOutputStore | TranscriptCodec | SqlClient.SqlClient,
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
  const itemHistory = GitHubItemHistory.layer.pipe(
    Layer.provide(app),
    Layer.provide(externalHttpClientLayer),
  );
  const itemChecks = engineItemChecksLayer(Layer.mergeAll(app, itemHistory, polling));
  // One Claude login lock per Worker, or per machine of a provisioned Worker, shared by the
  // executor's preflight and the Attempts' Claude children.
  const attemptRuntime = Layer.unwrap(
    Effect.gen(function* () {
      const startup = yield* (yield* CurrentInstance).get;
      const access = yield* parentModels(startup, instanceId);
      return durableAttemptRuntimeLayer(instanceDirectory, access);
    }),
  ).pipe(
    (runtime) => parentAdmissionLayer.pipe(Layer.provideMerge(runtime)),
    Layer.provideMerge(harnessesLive),
    Layer.provideMerge(hostLoginLockLayer),
    // The event-driven coordinator keeps its attempt journal in the runtime database.
    Layer.provide(database),
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
    Layer.provide(itemChecks),
    Layer.provide(attemptRuntime),
    Layer.provide(MarcbachmannCelLayer),
  );
  const itemWriter = GitHubItemWriter.layer.pipe(
    Layer.provide(app),
    Layer.provide(externalHttpClientLayer),
  );
  const files = GitHubFiles.layer.pipe(Layer.provide(app), Layer.provide(externalHttpClientLayer));
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
  // Supervisor sessions run in a container on this host; the view reports why they can't.
  const supervisorSandbox = supervisorSandboxLayer(instanceDirectory, instanceId).pipe(
    Layer.provide(NodeServices.layer),
  );
  const services = Layer.mergeAll(
    Operator.layer,
    OperatorConfiguration.layer,
    Orchestrator.layer,
  ).pipe(
    Layer.provide(Layer.mergeAll(dependencies, triggers, ci, itemHistory, app, supervisorSandbox)),
  );
  return Layer.mergeAll(dependencies, triggers, services, app, files, WebhookHealth.layer);
};
