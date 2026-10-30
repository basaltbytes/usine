import { CycleGeneration } from "@usine/core/cycle-budget";
import { ConfigParser } from "@usine/config/parser";
import { CursorStore } from "@usine/engine/cursor";
import { CycleBudgets } from "@usine/engine/cycle-budget";
import { RunEngine } from "@usine/engine/engine";
import { ItemProjectionReader, ItemProjectionWriter } from "@usine/engine/item-projection";
import { LoopControl, type LoopRuntimeState } from "@usine/engine/loop-control";
import { TriggerCondition } from "@usine/engine/trigger-condition";
import {
  RepositoryLabelProjectionReader,
  RepositoryLabelProjectionWriter,
} from "@usine/engine/repository-label-projection";
import { ExpressionEngine } from "@usine/expression/expression-engine";
import { GitHubLabelWriter } from "@usine/github/label-writer";
import { CommitSha } from "@usine/core/repository";
import { BaseRefHead, type BaseRefName, EntityTag, GitHubPolling } from "@usine/github/polling";
import { Effect, Layer, Option, Schema } from "effect";
import { LabelReconciler } from "../../src/label-reconciler.ts";
import { PollingTriggers } from "../../src/polling-triggers.ts";

const baseRefHeadAt = (baseRefName: BaseRefName, revision: number) =>
  new BaseRefHead({
    baseRefName,
    sha: CommitSha.make(revision.toString(16).padStart(40, "0")),
    entityTag: Option.some(EntityTag.make(`W/"${revision}"`)),
  });

/** A `GitHubPolling.baseRefHead` whose branches never move. */
export const unmovedBaseRefHead: GitHubPolling["Service"]["baseRefHead"] = (
  _repository,
  baseRefName,
  known,
) => Effect.succeed(Option.getOrElse(known, () => baseRefHeadAt(baseRefName, 0)));

/**
 * Returns base branches whose heads all move on `move`. A `baseRefHead` read returns the known head
 * while it is current, as GitHub does with a 304, and adds the branch to `reads`.
 */
export const baseBranches = () => {
  let revision = 0;
  const reads: Array<BaseRefName> = [];
  const baseRefHead: GitHubPolling["Service"]["baseRefHead"] = (_repository, baseRefName, known) =>
    Effect.sync(() => {
      reads.push(baseRefName);
      const head = baseRefHeadAt(baseRefName, revision);
      return Option.isSome(known) && known.value.sha === head.sha ? known.value : head;
    });
  return {
    baseRefHead,
    reads,
    move: () => {
      revision += 1;
    },
  };
};

export const itemProjectionWriterLayer = Layer.succeed(ItemProjectionWriter)({
  upsert: () => Effect.succeed(true),
  markGone: () => Effect.succeed(true),
});

const noItemProjections: ItemProjectionReader["Service"] = {
  get: () => Effect.succeed(Option.none()),
  list: () => Effect.succeed([]),
  openIssues: () => Effect.succeed([]),
};

export const itemProjectionReaderLayer = Layer.succeed(ItemProjectionReader)(noItemProjections);

/** A `TriggerCondition` whose recheck always returns `matches`. */
export const alwaysHoldsLayer = Layer.succeed(TriggerCondition)({
  recheck: () => Effect.succeed("matches"),
});

export const emptyCycleBudgets: CycleBudgets["Service"] = {
  generation: () => Effect.succeed(CycleGeneration.make(0)),
  asks: () => Effect.succeed([]),
  pendingResets: () => Effect.succeed([]),
  reset: () => Effect.die("unused cycle reset"),
  close: () => Effect.die("unused cycle ask closure"),
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

/** Returns an in-memory cursor store that also exposes what each poll persisted. */
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
  itemProjections: ItemProjectionReader["Service"] = noItemProjections,
) => {
  const cursors = Layer.succeed(CursorStore)(cursorStore);
  const expressions = Layer.succeed(ExpressionEngine)({
    relatedStringLiterals: () => Effect.die("unused"),
    checkBoolean: () => Effect.die("unused"),
    checkInteger: () => Effect.die("unused"),
    evaluateInteger: () => Effect.die("unused"),
    checkScalar: () => Effect.die("unused"),
    evaluateBoolean: () => Effect.die("unused"),
    evaluateBooleanEach: () => Effect.die("unused"),
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
    waitForUpgrade: () => Effect.void,
    cancelUpgrade: Effect.void,
    upgradeDrain: Effect.succeed(Option.none()),
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
    Layer.succeed(ItemProjectionReader)(itemProjections),
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
