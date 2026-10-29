import type { Worker } from "@usine/config/factory";
import { BotLogin } from "@usine/core/worker";
import { githubBotLogin } from "@usine/executor";
import { LaneName } from "@usine/config/board";
import { canonicalLabelName, GitHubLabelName } from "@usine/config/label";
import { type Attempt, AttemptId, AttemptWindow, windowHolds, windowOf } from "@usine/core/attempt";
import type { RunId } from "@usine/core/run";
import { type BoardMoveRecord, BoardMoves } from "@usine/engine/board-moves";
import type { RunStoreError } from "@usine/engine/engine";
import { RunReader } from "@usine/engine/run-reader";
import { TranscriptPageQuery } from "@usine/engine/transcript";
import { GitHubApp, type GitHubAppError } from "@usine/github/github-app";
import {
  GitHubItemHistory,
  type GitHubItemNotFoundError,
  type ItemChange,
  type LabelAdded,
  type LabelRemoved,
  ReviewState,
} from "@usine/github/item-history";
import type { RepositoryLabel } from "@usine/github/polling";
import { Clock, Context, DateTime, Effect, Layer, Match, Option, Ref, Schema } from "effect";
import { GitHubItemKey } from "../polling/repository-sync.ts";
import { LabelView } from "./board.ts";

/**
 * A label that an Attempt's Agent added to the Run's Item, with GitHub's current label definition.
 */
export class LabelAddedView extends Schema.TaggedClass<LabelAddedView>(
  "@usine/orchestrator/LabelAddedView",
)("LabelAdded", { at: Schema.String, label: LabelView }) {}

/**
 * A label that an Attempt's Agent removed from the Run's Item, with GitHub's current label
 * definition.
 */
export class LabelRemovedView extends Schema.TaggedClass<LabelRemovedView>(
  "@usine/orchestrator/LabelRemovedView",
)("LabelRemoved", { at: Schema.String, label: LabelView }) {}

/** A comment that an Attempt's Agent posted on the Run's Item. */
export class CommentedView extends Schema.TaggedClass<CommentedView>(
  "@usine/orchestrator/CommentedView",
)("Commented", { at: Schema.String, url: Schema.String }) {}

/** A review that an Attempt's Agent submitted on the Run's pull request, with its current state. */
export class ReviewedView extends Schema.TaggedClass<ReviewedView>(
  "@usine/orchestrator/ReviewedView",
)("Reviewed", { at: Schema.String, url: Schema.String, state: ReviewState }) {}

/**
 * An operator move of the Run's Item between Board lanes during an Attempt. `at` is when the
 * operator made the move.
 */
export class BoardMovedView extends Schema.TaggedClass<BoardMovedView>(
  "@usine/orchestrator/BoardMovedView",
)("BoardMoved", { at: Schema.String, fromLane: LaneName, toLane: LaneName }) {}

/**
 * A change on the Run's GitHub Item during an Attempt: one made by the Agent, or an operator Board
 * move.
 */
export const GitHubChangeView = Schema.Union([
  LabelAddedView,
  LabelRemovedView,
  CommentedView,
  ReviewedView,
  BoardMovedView,
]);
export type GitHubChangeView = typeof GitHubChangeView.Type;

/** The changes on the Run's GitHub Item during one Attempt, oldest first. */
export class AttemptGitHubChangesView extends Schema.Class<AttemptGitHubChangesView>(
  "@usine/orchestrator/AttemptGitHubChangesView",
)({ attemptId: AttemptId, changes: Schema.Array(GitHubChangeView) }) {}

/**
 * The GitHub changes of each of a Run's Attempts, in Attempt order. Empty for a Run without a
 * GitHub Item, such as a schedule Run.
 */
export class RunGitHubChangesView extends Schema.Class<RunGitHubChangesView>(
  "@usine/orchestrator/RunGitHubChangesView",
)({ attempts: Schema.Array(AttemptGitHubChangesView) }) {}

export type RunGitHubChangesError = RunStoreError | GitHubAppError | GitHubItemNotFoundError;

/** The maximum number of ended Attempts whose changes are cached; the oldest are evicted first. */
const CACHE_CAPACITY = 1_000;
/**
 * The time after an Attempt ends before its changes are cached, since GitHub's timeline can trail a
 * write by seconds.
 */
const SETTLE_MILLIS = 60_000;
/**
 * The maximum lag of GitHub's clock behind the orchestrator's when recording a Board move's label
 * change.
 */
const CLOCK_SKEW_MILLIS = 1_000;
/** The maximum time after a Board move is recorded for all its label writes to appear on GitHub. */
const MOVE_SPAN_MILLIS = 10_000;

/**
 * Assigns each change to the one Attempt whose window contains it. A change inside two Attempts'
 * windows with the same bot identity is assigned to neither.
 */
const attribute = (windows: ReadonlyArray<AttemptWindow>, changes: ReadonlyArray<ItemChange>) => {
  const attributed = new Map<AttemptId, Array<ItemChange>>();
  const ambiguous: Array<ItemChange> = [];
  for (const change of changes) {
    const holders = windows.filter((window) => windowHolds(window, change.at));
    const [holder, ...others] = holders;
    if (holder === undefined) continue;
    if (others.length > 0) {
      ambiguous.push(change);
      continue;
    }
    attributed.set(holder.attemptId, [...(attributed.get(holder.attemptId) ?? []), change]);
  }
  return { attributed, ambiguous };
};

/**
 * Whether `move` made this label change: same label and direction, recorded between the move time
 * minus clock skew and the end of the move's span.
 */
const madeBy = (change: LabelAdded | LabelRemoved) => (move: BoardMoveRecord) => {
  const recorded = DateTime.toEpochMillis(move.at);
  const earliest = recorded - CLOCK_SKEW_MILLIS;
  const at = DateTime.toEpochMillis(change.at);
  const name = canonicalLabelName(change.label.name);
  return (
    earliest - (earliest % 1_000) <= at &&
    at <= recorded + MOVE_SPAN_MILLIS &&
    (change._tag === "LabelAdded" ? move.added : move.removed).some(
      (label) => canonicalLabelName(label) === name,
    )
  );
};

/**
 * Splits the App's changes into the Board moves that made some of them and the remaining changes.
 * Drops moves with no change on the timeline, such as writes GitHub refused.
 */
const separateBoardMoves = (
  moves: ReadonlyArray<BoardMoveRecord>,
  changes: ReadonlyArray<ItemChange>,
) => {
  const made = new Set<BoardMoveRecord>();
  const rest: Array<ItemChange> = [];
  for (const change of changes) {
    const move =
      change._tag === "LabelAdded" || change._tag === "LabelRemoved"
        ? moves.find(madeBy(change))
        : undefined;
    if (move === undefined) rest.push(change);
    else made.add(move);
  }
  return { moves: moves.filter((move) => made.has(move)), rest };
};

const labelView = (label: RepositoryLabel) =>
  new LabelView({
    name: GitHubLabelName.make(label.name),
    color: label.color,
    description: Option.getOrNull(label.description),
  });

const changeView = (change: ItemChange): GitHubChangeView =>
  Match.valueTags(change, {
    LabelAdded: ({ at, label }) =>
      new LabelAddedView({ at: DateTime.formatIso(at), label: labelView(label) }),
    LabelRemoved: ({ at, label }) =>
      new LabelRemovedView({ at: DateTime.formatIso(at), label: labelView(label) }),
    Commented: ({ at, url }) => new CommentedView({ at: DateTime.formatIso(at), url }),
    Reviewed: ({ at, url, state }) => new ReviewedView({ at: DateTime.formatIso(at), url, state }),
  });

const moveView = (move: BoardMoveRecord) =>
  new BoardMovedView({
    at: DateTime.formatIso(move.at),
    fromLane: LaneName.make(move.fromLane),
    toLane: LaneName.make(move.toLane),
  });

const makeRunGitHubChanges = Effect.gen(function* () {
  const reader = yield* RunReader;
  const history = yield* GitHubItemHistory;
  const app = yield* GitHubApp;
  const boardMoves = yield* BoardMoves;
  const cache = yield* Ref.make(new Map<string, ReadonlyArray<GitHubChangeView>>());

  // Attempts that ended before end times were recorded end at their last transcript row.
  const windowFor = Effect.fn("RunGitHubChanges.windowFor")(function* (attempt: Attempt) {
    yield* Effect.annotateCurrentSpan({ attemptId: attempt.id, worker: attempt.worker });
    const recorded = windowOf(attempt);
    if (Option.isSome(recorded)) return recorded;
    const [last] = yield* reader.transcript(
      new TranscriptPageQuery({ attemptId: attempt.id, before: Option.none(), limit: 1 }),
    );
    if (last === undefined) {
      yield* Effect.logInfo(
        "An ended Attempt has neither an end time nor a transcript; no GitHub change is placed in it",
        { attemptId: attempt.id },
      );
      return Option.none<AttemptWindow>();
    }
    return Option.some(
      new AttemptWindow({
        attemptId: attempt.id,
        startedAt: attempt.startedAt,
        endedAt: Option.some(last.receivedAt),
      }),
    );
  });

  const read = Effect.fn("RunGitHubChanges.read")(function* (
    workers: ReadonlyArray<Worker>,
    runId: RunId,
  ) {
    yield* Effect.annotateCurrentSpan({ runId });
    const snapshot = yield* reader.inspect(runId);
    const item = Schema.decodeOption(GitHubItemKey)(snapshot.itemKey);
    if (Option.isNone(item)) {
      yield* Effect.logDebug("The Run has no GitHub Item, so it has no GitHub changes", { runId });
      return new RunGitHubChangesView({ attempts: [] });
    }
    const [, , number] = item.value;
    const repository = snapshot.repository;
    yield* Effect.annotateCurrentSpan({ repository, item: number });
    const view = (changes: ReadonlyMap<AttemptId, ReadonlyArray<GitHubChangeView>>) =>
      new RunGitHubChangesView({
        attempts: snapshot.attempts.map(
          ({ id }) =>
            new AttemptGitHubChangesView({ attemptId: id, changes: changes.get(id) ?? [] }),
        ),
      });
    if (snapshot.attempts.length === 0) return view(new Map());
    const { appSlug } = yield* app.installation();
    const appActor = BotLogin.make(`${appSlug}[bot]`);
    const workerActors = new Map(
      workers.map(({ name, kind }) => [name, githubBotLogin(kind, appActor)]),
    );
    const identityKey = JSON.stringify([
      appActor,
      [...workerActors].sort(([left], [right]) => left.localeCompare(right)),
    ]);
    const cacheKey = (attempt: Attempt) =>
      Option.map(Option.fromUndefinedOr(workerActors.get(attempt.worker)), (actor) =>
        JSON.stringify([attempt.id, actor, identityKey]),
      );
    const stored = yield* Ref.get(cache);
    const cached = new Map(
      snapshot.attempts.flatMap((attempt) =>
        Option.toArray(
          Option.flatMap(cacheKey(attempt), (key) =>
            Option.map(
              Option.fromUndefinedOr(stored.get(key)),
              (changes) => [attempt.id, changes] as const,
            ),
          ),
        ),
      ),
    );
    const missing = snapshot.attempts.filter(({ id }) => !cached.has(id));
    if (missing.length === 0) {
      yield* Effect.logDebug("Served the Run's GitHub changes from the Attempt cache", {
        runId,
        attempts: snapshot.attempts.length,
      });
      return view(cached);
    }

    const itemRuns = yield* reader.forItems([snapshot.itemKey]);
    const onItem = new Map<AttemptId, Attempt>(
      [...itemRuns.flatMap(({ attempts }) => attempts), ...snapshot.attempts].map((attempt) => [
        attempt.id,
        attempt,
      ]),
    );
    const actors = new Map<AttemptId, BotLogin>();
    for (const attempt of onItem.values()) {
      const actor = workerActors.get(attempt.worker);
      if (actor === undefined) {
        yield* Effect.logWarning(
          "Attempt worker is no longer configured; its GitHub writer is unknown",
          {
            runId,
            attemptId: attempt.id,
            worker: attempt.worker,
          },
        );
      } else actors.set(attempt.id, actor);
    }
    const windows = (yield* Effect.forEach([...onItem.values()], windowFor)).flatMap(
      Option.toArray,
    );
    const now = yield* Clock.currentTimeMillis;
    const fresh = new Map<AttemptId, ReadonlyArray<GitHubChangeView>>();
    const settled: Array<AttemptId> = [];
    const placeable = missing.flatMap((attempt) => {
      const window = windows.find(({ attemptId }) => attemptId === attempt.id);
      if (window !== undefined) return [window];
      fresh.set(attempt.id, []);
      settled.push(attempt.id);
      return [];
    });
    if (placeable.length > 0) {
      const earliest = Math.min(
        ...placeable.map(({ startedAt }) => DateTime.toEpochMillis(startedAt)),
      );
      const since = DateTime.makeUnsafe(earliest - (earliest % 1_000));
      // A move recorded shortly before the earliest window can still appear in it.
      const [timelines, recorded] = yield* Effect.all(
        [
          Effect.forEach(
            [
              ...new Set([
                appActor,
                ...placeable.flatMap(({ attemptId }) =>
                  Option.toArray(Option.fromUndefinedOr(actors.get(attemptId))),
                ),
              ]),
            ],
            (actor) =>
              history
                .appChanges(repository, number, since, actor)
                .pipe(Effect.map((changes) => [actor, changes] as const)),
            { concurrency: "unbounded" },
          ),
          boardMoves.onItem(
            snapshot.itemKey,
            DateTime.subtract(since, { milliseconds: MOVE_SPAN_MILLIS }),
          ),
        ],
        { concurrency: "unbounded" },
      );
      const byActor = new Map(timelines);
      const appChanges = byActor.get(appActor) ?? [];
      const { moves, rest } = separateBoardMoves(recorded, appChanges);
      byActor.set(appActor, rest);
      const attributed = new Map<AttemptId, ReadonlyArray<ItemChange>>();
      for (const [actor, changes] of byActor) {
        const matching = windows.filter(
          ({ attemptId }) => !actors.has(attemptId) || actors.get(attemptId) === actor,
        );
        const result = attribute(matching, changes);
        for (const [attemptId, own] of result.attributed)
          if (actors.get(attemptId) === actor) attributed.set(attemptId, own);
        if (result.ambiguous.length > 0)
          yield* Effect.logInfo(
            "Left out GitHub changes that overlapping attempts with the same writer could each have made",
            {
              runId,
              repository,
              item: number,
              actor,
              changes: result.ambiguous.length,
              at: result.ambiguous.map(({ at }) => DateTime.formatIso(at)).join(", "),
            },
          );
      }
      for (const window of placeable) {
        const own = [
          ...(attributed.get(window.attemptId) ?? []).map((change) => ({
            at: DateTime.toEpochMillis(change.at),
            view: changeView(change),
          })),
          ...moves.flatMap((move) => {
            const at = DateTime.toEpochMillis(move.at);
            const during =
              DateTime.toEpochMillis(window.startedAt) <= at &&
              Option.match(window.endedAt, {
                onNone: () => true,
                onSome: (last) => at <= DateTime.toEpochMillis(last),
              });
            return during ? [{ at, view: moveView(move) }] : [];
          }),
        ];
        fresh.set(
          window.attemptId,
          own.sort((left, right) => left.at - right.at).map(({ view }) => view),
        );
        if (
          Option.isSome(window.endedAt) &&
          now - DateTime.toEpochMillis(window.endedAt.value) >= SETTLE_MILLIS
        )
          settled.push(window.attemptId);
      }
      yield* Effect.logInfo("Read worker GitHub changes on a run item", {
        runId,
        repository,
        item: number,
        since: DateTime.formatIso(since),
        appChanges: timelines.reduce((count, [, changes]) => count + changes.length, 0),
        boardMoves: recorded.length,
        boardMoveChanges: appChanges.length - rest.length,
        placed: placeable.reduce(
          (count, { attemptId }) => count + (attributed.get(attemptId)?.length ?? 0),
          0,
        ),
        cachedAttempts: settled.length,
      });
    }
    yield* Ref.update(cache, (current) => {
      const next = new Map(current);
      for (const attempt of missing) {
        if (!settled.includes(attempt.id)) continue;
        for (const key of Option.toArray(cacheKey(attempt)))
          next.set(key, fresh.get(attempt.id) ?? []);
      }
      for (const oldest of [...next.keys()].slice(0, Math.max(0, next.size - CACHE_CAPACITY)))
        next.delete(oldest);
      return next;
    });
    return view(new Map([...cached, ...fresh]));
  });

  return { read } as const;
});

/**
 * Reads the agent's label, comment, and review changes and the operator's board moves on the run's
 * GitHub item during each attempt, using the configured kind of its worker. A removed worker's
 * writer is unknown, so its agent changes are omitted. Label changes made by a recorded board move
 * are the operator's. Another exe.dev VM writing in the same attempt window can be attributed to
 * the attempt because exe.dev VMs share one integration bot.
 */
export class RunGitHubChanges extends Context.Service<
  RunGitHubChanges,
  {
    readonly read: (
      workers: ReadonlyArray<Worker>,
      runId: RunId,
    ) => Effect.Effect<RunGitHubChangesView, RunGitHubChangesError>;
  }
>()("@usine/orchestrator/RunGitHubChanges") {
  static readonly layer = Layer.effect(RunGitHubChanges, makeRunGitHubChanges);
}
