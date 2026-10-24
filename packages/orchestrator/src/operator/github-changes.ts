import { LaneName } from "@usine/config/board";
import { canonicalLabelName, GitHubLabelName } from "@usine/config/label";
import { type Attempt, AttemptId, AttemptWindow, windowHolds, windowOf } from "@usine/core/attempt";
import type { RunId } from "@usine/core/run";
import { type BoardMoveRecord, BoardMoves } from "@usine/engine/board-moves";
import type { RunStoreError } from "@usine/engine/engine";
import { RunReader } from "@usine/engine/run-reader";
import { TranscriptPageQuery } from "@usine/engine/transcript";
import type { GitHubAppError } from "@usine/github/github-app";
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
 * windows is assigned to neither, since every Agent writes as the same App.
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
  const boardMoves = yield* BoardMoves;
  const cache = yield* Ref.make(new Map<AttemptId, ReadonlyArray<GitHubChangeView>>());

  // Attempts that ended before end times were recorded end at their last transcript row.
  const windowFor = Effect.fn("RunGitHubChanges.windowFor")(function* (attempt: Attempt) {
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

  const read = Effect.fn("RunGitHubChanges.read")(function* (runId: RunId) {
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
    const cached = yield* Ref.get(cache);
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
      const [changes, recorded] = yield* Effect.all(
        [
          history.appChanges(repository, number, since),
          boardMoves.onItem(
            snapshot.itemKey,
            DateTime.subtract(since, { milliseconds: MOVE_SPAN_MILLIS }),
          ),
        ],
        { concurrency: "unbounded" },
      );
      const { moves, rest } = separateBoardMoves(recorded, changes);
      const { attributed, ambiguous } = attribute(windows, rest);
      if (ambiguous.length > 0)
        yield* Effect.logInfo(
          "Left out GitHub changes that overlapping Attempts on the Item could each have made",
          {
            runId,
            repository,
            item: number,
            changes: ambiguous.length,
            at: ambiguous.map(({ at }) => DateTime.formatIso(at)).join(", "),
          },
        );
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
      yield* Effect.logInfo("Read the App's GitHub changes on a Run's Item", {
        runId,
        repository,
        item: number,
        since: DateTime.formatIso(since),
        appChanges: changes.length,
        boardMoves: recorded.length,
        boardMoveChanges: changes.length - rest.length,
        placed: placeable.reduce(
          (count, { attemptId }) => count + (attributed.get(attemptId)?.length ?? 0),
          0,
        ),
        cachedAttempts: settled.length,
      });
    }
    const merged = yield* Ref.updateAndGet(cache, (current) => {
      const next = new Map(current);
      for (const attemptId of settled) next.set(attemptId, fresh.get(attemptId) ?? []);
      for (const oldest of [...next.keys()].slice(0, Math.max(0, next.size - CACHE_CAPACITY)))
        next.delete(oldest);
      return next;
    });
    return view(new Map([...merged, ...fresh]));
  });

  return { read } as const;
});

/**
 * Reads the Agent's label, comment, and review changes and the operator's Board moves on the Run's
 * GitHub Item during each Attempt. Label changes made by a recorded Board move are the operator's.
 */
export class RunGitHubChanges extends Context.Service<
  RunGitHubChanges,
  {
    readonly read: (runId: RunId) => Effect.Effect<RunGitHubChangesView, RunGitHubChangesError>;
  }
>()("@usine/orchestrator/RunGitHubChanges") {
  static readonly layer = Layer.effect(RunGitHubChanges, makeRunGitHubChanges);
}
