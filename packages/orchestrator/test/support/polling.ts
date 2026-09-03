import { ConfigParser } from "@usine/config";
import {
  CursorStore,
  ItemProjectionWriter,
  LoopControl,
  type LoopRuntimeState,
  RepositoryLabelProjectionReader,
  RepositoryLabelProjectionWriter,
  RunEngine,
} from "@usine/engine";
import { ExpressionEngine } from "@usine/expression";
import { GitHubLabelWriter, GitHubPolling } from "@usine/github";
import { Effect, Layer, Option } from "effect";
import { LabelReconciler, PollingTriggers } from "../../src/index.ts";

export const itemProjectionWriterLayer = Layer.succeed(ItemProjectionWriter)({
  upsert: () => Effect.succeed(true),
});

export const repositoryLabelProjectionWriterLayer = Layer.succeed(RepositoryLabelProjectionWriter)({
  replace: () => Effect.succeed(true),
});

export const repositoryLabelProjectionReaderLayer = Layer.succeed(RepositoryLabelProjectionReader)({
  get: () => Effect.succeed(Option.none()),
});

export const inertGitHubLabelWriterLayer = Layer.succeed(GitHubLabelWriter)({
  create: () => Effect.die("no labels are declared by the polling fixture"),
});

export const inertLabelReconcilerLayer = LabelReconciler.layer.pipe(
  Layer.provide(inertGitHubLabelWriterLayer),
);

export const loopControlLayer = (states: ReadonlyArray<LoopRuntimeState> = []) =>
  Layer.succeed(LoopControl)({
    isPaused: (loop) => Effect.succeed(states.some((state) => state.loop === loop && state.paused)),
    pause: () => Effect.die("unused"),
    states: Effect.succeed(states),
    unpause: () => Effect.die("unused"),
  });

export const pollingTestLayer = (
  github: GitHubPolling["Service"],
  states: ReadonlyArray<LoopRuntimeState> = [],
  labelWriter: GitHubLabelWriter["Service"] = {
    create: () => Effect.die("no labels are declared by the polling fixture"),
  },
) => {
  const cursors = Layer.succeed(CursorStore)({
    read: () => Effect.succeed(Option.none()),
    write: () => Effect.void,
  });
  const expressions = Layer.succeed(ExpressionEngine)({
    relatedStringLiterals: () => Effect.die("unused"),
    checkBoolean: () => Effect.die("unused"),
    checkScalar: () => Effect.die("unused"),
    evaluateBoolean: () => Effect.die("unused"),
    evaluateScalar: () => Effect.die("unused"),
  });
  const runs = Layer.succeed(RunEngine)({
    approve: () => Effect.die("unused"),
    cancel: () => Effect.die("unused"),
    inspect: () => Effect.die("unused"),
    reconcile: () => Effect.die("unused"),
    retry: () => Effect.die("unused"),
    revoke: () => Effect.die("unused"),
    submit: () => Effect.die("unused"),
    transcript: () => Effect.die("unused"),
  });
  const parser = ConfigParser.layer.pipe(Layer.provide(expressions));
  const writer = Layer.succeed(GitHubLabelWriter)(labelWriter);
  const reconciler = LabelReconciler.layer.pipe(Layer.provide(writer));
  const dependencies = Layer.mergeAll(
    cursors,
    expressions,
    itemProjectionWriterLayer,
    repositoryLabelProjectionWriterLayer,
    repositoryLabelProjectionReaderLayer,
    reconciler,
    parser,
    runs,
    loopControlLayer(states),
    Layer.succeed(GitHubPolling, github),
  );
  return PollingTriggers.layer.pipe(Layer.provide(dependencies));
};
