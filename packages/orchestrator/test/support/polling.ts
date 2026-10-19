import { CycleGeneration } from "@usine/core/cycle-budget";
import { ConfigParser } from "@usine/config/parser";
import { CursorStore } from "@usine/engine/cursor";
import { CycleBudgets } from "@usine/engine/cycle-budget";
import { RunEngine } from "@usine/engine/engine";
import { ItemProjectionWriter } from "@usine/engine/item-projection";
import { LoopControl, type LoopRuntimeState } from "@usine/engine/loop-control";
import { TriggerCondition } from "@usine/engine/trigger-condition";
import {
  RepositoryLabelProjectionReader,
  RepositoryLabelProjectionWriter,
} from "@usine/engine/repository-label-projection";
import { ExpressionEngine } from "@usine/expression/expression-engine";
import { GitHubLabelWriter } from "@usine/github/label-writer";
import { GitHubPolling } from "@usine/github/polling";
import { Effect, Layer, Option, Schema } from "effect";
import { LabelReconciler } from "../../src/label-reconciler.ts";
import { PollingTriggers } from "../../src/polling-triggers.ts";

export const itemProjectionWriterLayer = Layer.succeed(ItemProjectionWriter)({
  upsert: () => Effect.succeed(true),
  markGone: () => Effect.succeed(true),
});

/** A queued Event always keeps its turn: the engine's pre-check behavior. */
export const alwaysHoldsLayer = Layer.succeed(TriggerCondition)({
  holds: () => Effect.succeed(true),
});

export const emptyCycleBudgets: CycleBudgets["Service"] = {
  generation: () => Effect.succeed(CycleGeneration.make(0)),
  asks: () => Effect.succeed([]),
  pendingResets: () => Effect.succeed([]),
  reset: () => Effect.die("unused cycle reset"),
  acknowledgeReset: () => Effect.die("unused cycle reset acknowledgement"),
};

export const noCycleBudgets = Layer.succeed(CycleBudgets)(emptyCycleBudgets);

export const repositoryLabelProjectionWriterLayer = Layer.succeed(RepositoryLabelProjectionWriter)({
  replace: () => Effect.succeed(true),
});

const noRepositoryLabelProjections: RepositoryLabelProjectionReader["Service"] = {
  get: () => Effect.succeed(Option.none()),
};

export const repositoryLabelProjectionReaderLayer = Layer.succeed(RepositoryLabelProjectionReader)(
  noRepositoryLabelProjections,
);

const forgetfulCursorStore: CursorStore["Service"] = {
  read: () => Effect.succeed(Option.none()),
  write: () => Effect.void,
};

/** An in-memory cursor store that also exposes what each poll persisted. */
export const memoryCursorStore = () => {
  const stored = new Map<string, Schema.Json>();
  const store: CursorStore["Service"] = {
    read: (key, schema) =>
      Effect.sync(() =>
        Option.map(Option.fromNullishOr(stored.get(key)), Schema.decodeUnknownSync(schema)),
      ),
    write: (key, schema, value) =>
      Effect.sync(() => {
        stored.set(key, Schema.encodeSync(schema)(value));
      }),
  };
  return { store, stored };
};

const inertGitHubLabelWriter: GitHubLabelWriter["Service"] = {
  create: () => Effect.die("no labels are declared by the polling fixture"),
};

export const inertGitHubLabelWriterLayer = Layer.succeed(GitHubLabelWriter)(inertGitHubLabelWriter);

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
  labelWriter: GitHubLabelWriter["Service"] = inertGitHubLabelWriter,
  labelProjections: RepositoryLabelProjectionReader["Service"] = noRepositoryLabelProjections,
  cursorStore: CursorStore["Service"] = forgetfulCursorStore,
  cycleBudgets: CycleBudgets["Service"] = emptyCycleBudgets,
) => {
  const cursors = Layer.succeed(CursorStore)(cursorStore);
  const expressions = Layer.succeed(ExpressionEngine)({
    relatedStringLiterals: () => Effect.die("unused"),
    checkBoolean: () => Effect.die("unused"),
    checkScalar: () => Effect.die("unused"),
    evaluateBoolean: () => Effect.die("unused"),
    evaluateScalar: () => Effect.die("unused"),
  });
  const runs = Layer.succeed(RunEngine)({
    resolveFailure: () => Effect.void,
    intervene: () => Effect.void,
    approve: () => Effect.die("unused"),
    cancel: () => Effect.die("unused"),
    discardLeftovers: () => Effect.die("unused"),
    inspect: () => Effect.die("unused"),
    reconcile: () => Effect.die("unused"),
    drain: () => Effect.void,
    retry: () => Effect.die("unused"),
    runAgain: () => Effect.die("unused"),
    revoke: () => Effect.die("unused"),
    submit: () => Effect.die("unused"),
    transcript: () => Effect.die("unused"),
  });
  const parser = ConfigParser.layer.pipe(Layer.provide(expressions));
  const writer = Layer.succeed(GitHubLabelWriter)(labelWriter);
  const reconciler = LabelReconciler.layer.pipe(Layer.provide(writer));
  const dependencies = Layer.mergeAll(
    Layer.succeed(CycleBudgets)(cycleBudgets),
    cursors,
    expressions,
    itemProjectionWriterLayer,
    repositoryLabelProjectionWriterLayer,
    Layer.succeed(RepositoryLabelProjectionReader)(labelProjections),
    reconciler,
    parser,
    runs,
    loopControlLayer(states),
    Layer.succeed(GitHubPolling, github),
  );
  return PollingTriggers.layer.pipe(Layer.provide(dependencies));
};
