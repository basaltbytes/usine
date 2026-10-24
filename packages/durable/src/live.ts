import { NodeServices } from "@effect/platform-node";
import { getAgentDir, ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { ModelRef } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { childDispatcherLayer } from "@usine/agents/children";
import { claudeChildBackendLayer, claudeSdkLive } from "@usine/agents/claude";
import { codexAppServerLive, codexChildBackendLayer } from "@usine/agents/codex";
import { piChildBackendLayer, piSdkLive } from "@usine/agents/pi";
import type { InstanceDirectory } from "@usine/core/instance";
import { Effect, FileSystem, Layer, Option, Path } from "effect";
import { layer as attemptRuntimeLayer } from "./attempt/runtime.ts";
import {
  type DurableHarnessOptions,
  durableError,
  layer as durableHarnessLayer,
} from "./harness.ts";
import { durableStoragePath } from "./storage-path.ts";

const nodeOptions = Effect.fn("DurableHarness.nodeOptions")(function* (
  instanceDirectory: InstanceDirectory,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = durableStoragePath(path, instanceDirectory);
  const models = yield* Effect.tryPromise({
    try: (signal) => ModelRuntime.create({ signal }),
    catch: (cause) => durableError("load the Pi model runtime", cause),
  });
  // Only the Pi user's global settings: the instance folder's own `.pi/` is not trusted.
  const settings = SettingsManager.create(instanceDirectory, getAgentDir(), {
    projectTrusted: false,
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
}, Effect.provide(NodeServices.layer));

/**
 * Provides the durable harness on `.usine/durable.sqlite` with Pi's configured models and
 * credentials.
 */
export const harnessLayer = (instanceDirectory: InstanceDirectory) =>
  Layer.unwrap(Effect.map(nodeOptions(instanceDirectory), durableHarnessLayer));

const childImplementations = Layer.mergeAll(
  claudeChildBackendLayer.pipe(Layer.provide(claudeSdkLive)),
  codexChildBackendLayer.pipe(Layer.provide(codexAppServerLive)),
  piChildBackendLayer.pipe(Layer.provide(piSdkLive)),
);

/** Provides the Claude Code, Codex, and Pi child backends, selected by the Agent's harness. */
export const childBackendLayer = childDispatcherLayer.pipe(Layer.provide(childImplementations));

/**
 * Provides the Node `AttemptRuntime` with the real child backends. Building it resumes every
 * unfinished Attempt.
 */
export const layer = (instanceDirectory: InstanceDirectory) =>
  attemptRuntimeLayer.pipe(
    Layer.provideMerge(harnessLayer(instanceDirectory)),
    Layer.provide(childBackendLayer),
  );
