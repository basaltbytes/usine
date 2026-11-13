import { NodeServices } from "@effect/platform-node";
import { getAgentDir, ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { ModelRef } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { Harnesses } from "@usine/agents/harness/node";
import type { ChildBackend } from "@usine/agents/runtime";
import { childDispatcherLayer } from "@usine/agents/children";
import type { InstanceDirectory } from "@usine/core/instance";
import { Effect, FileSystem, Layer, Option, Path } from "effect";
import { layer as attemptRuntimeLayer } from "./attempt/runtime.ts";
import { completionWakeUp } from "./coordinator/completion.ts";
import { routerLayer } from "./coordinator/router.ts";
import { CoordinatorRuntime } from "./coordinator/runtime.ts";
import { sqliteAttemptJournalLayer } from "./coordinator/sqlite/store.ts";
import {
  type DurableHarnessOptions,
  durableError,
  layer as durableHarnessLayer,
} from "./harness.ts";
import { durableStoragePath } from "./storage-path.ts";
import type { ParentModelAccess } from "./gateway.ts";
import { configureHarnessHttp } from "./http-dispatcher.ts";

/** Loads the orchestrator's Pi models and credentials without opening durable storage. */
export const loadParentModels = Effect.fn("ParentModels.load")(function* (
  instanceDirectory: InstanceDirectory,
  access?: ParentModelAccess,
) {
  yield* Effect.annotateCurrentSpan({ directory: instanceDirectory });
  // Only the Pi user's global settings: the instance folder's own `.pi/` is not trusted.
  const settings = SettingsManager.create(instanceDirectory, getAgentDir(), {
    projectTrusted: false,
  });
  yield* configureHarnessHttp(settings.getGlobalSettings().httpProxy);
  const models =
    access?.models ??
    (yield* Effect.tryPromise({
      try: (signal) => ModelRuntime.create({ signal }),
      catch: (cause) => durableError("load the Pi model runtime", cause),
    }));
  const defaultModel = Option.flatMap(
    Option.fromNullishOr(settings.getDefaultProvider()),
    (provider) =>
      Option.map(Option.fromNullishOr(settings.getDefaultModel()), (modelId): ModelRef => ({
        provider,
        modelId,
      })),
  );
  return {
    models,
    defaultModel,
    credentials: access?.credentials ?? { route: "host-login" as const },
  };
});

const nodeOptions = Effect.fn("DurableHarness.nodeOptions")(function* (
  instanceDirectory: InstanceDirectory,
  access?: ParentModelAccess,
) {
  yield* Effect.annotateCurrentSpan({ directory: instanceDirectory });
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = durableStoragePath(path, instanceDirectory);
  const { models, defaultModel } = yield* loadParentModels(instanceDirectory, access);
  yield* Effect.logInfo("Durable harness storage", { file });
  return {
    openStorage: fileSystem.makeDirectory(path.dirname(file), { recursive: true }).pipe(
      Effect.mapError((cause) => durableError("create the durable storage folder", cause)),
      Effect.andThen(
        Effect.tryPromise({
          try: () => openNodeSqliteStorage(file),
          catch: (cause) => durableError("open the durable storage", cause),
        }),
      ),
    ),
    models,
    credentials: access?.credentials ?? { route: "host-login" as const },
    defaultModel,
  } satisfies DurableHarnessOptions;
});

/**
 * Provides the durable harness on `.usine/durable.sqlite` with Pi's configured models and
 * credentials.
 */
export const harnessLayer = (instanceDirectory: InstanceDirectory, access?: ParentModelAccess) =>
  Layer.unwrap(Effect.map(nodeOptions(instanceDirectory, access), durableHarnessLayer)).pipe(
    Layer.provide(NodeServices.layer),
  );

/** Provides child sessions through the registered harness runtimes. */
export const childBackendLayer: Layer.Layer<ChildBackend, never, Harnesses> = childDispatcherLayer;

/**
 * Provides the Node `AttemptRuntime` with the real child backends: the Pi parent's runtime on
 * `.usine/durable.sqlite`, and the event-driven coordinator, whose attempt journal migrates and
 * uses the runtime database's `SqlClient`. The coordinator decides a report without a reserved
 * marker with a structured completion when the agent has a `decision` brain. Building it resumes
 * every unfinished Pi Attempt.
 */
export const layer = (instanceDirectory: InstanceDirectory, access?: ParentModelAccess) =>
  routerLayer.pipe(
    Layer.provide(Layer.mergeAll(attemptRuntimeLayer, CoordinatorRuntime.layer)),
    Layer.provide(completionWakeUp),
    Layer.provide(sqliteAttemptJournalLayer),
    Layer.provideMerge(harnessLayer(instanceDirectory, access)),
    Layer.provide(childBackendLayer),
  );
