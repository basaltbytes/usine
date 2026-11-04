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
import {
  type DurableHarnessOptions,
  durableError,
  layer as durableHarnessLayer,
} from "./harness.ts";
import { durableStoragePath } from "./storage-path.ts";
import { configureHarnessHttp } from "./http-dispatcher.ts";

const nodeOptions = Effect.fn("DurableHarness.nodeOptions")(function* (
  instanceDirectory: InstanceDirectory,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = durableStoragePath(path, instanceDirectory);
  // Only the Pi user's global settings: the instance folder's own `.pi/` is not trusted.
  const settings = SettingsManager.create(instanceDirectory, getAgentDir(), {
    projectTrusted: false,
  });
  yield* configureHarnessHttp(settings.getGlobalSettings().httpProxy);
  const models = yield* Effect.tryPromise({
    try: (signal) => ModelRuntime.create({ signal }),
    catch: (cause) => durableError("load the Pi model runtime", cause),
  });
  const defaultModel = Option.flatMap(
    Option.fromNullishOr(settings.getDefaultProvider()),
    (provider) =>
      Option.map(Option.fromNullishOr(settings.getDefaultModel()), (modelId): ModelRef => ({
        provider,
        modelId,
      })),
  );
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
    defaultModel,
  } satisfies DurableHarnessOptions;
});

/**
 * Provides the durable harness on `.usine/durable.sqlite` with Pi's configured models and
 * credentials.
 */
export const harnessLayer = (instanceDirectory: InstanceDirectory) =>
  Layer.unwrap(Effect.map(nodeOptions(instanceDirectory), durableHarnessLayer)).pipe(
    Layer.provide(NodeServices.layer),
  );

/** Provides child sessions through the registered harness runtimes. */
export const childBackendLayer: Layer.Layer<ChildBackend, never, Harnesses> = childDispatcherLayer;

/**
 * Provides the Node `AttemptRuntime` with the real child backends. Building it resumes every
 * unfinished Attempt.
 */
export const layer = (instanceDirectory: InstanceDirectory) =>
  attemptRuntimeLayer.pipe(
    Layer.provideMerge(harnessLayer(instanceDirectory)),
    Layer.provide(childBackendLayer),
  );
