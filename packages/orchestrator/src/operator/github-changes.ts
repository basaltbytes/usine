import { LaneName } from "@usine/config/board";
import { canonicalLabelName, GitHubLabelName } from "@usine/config/label";
import { type Attempt, AttemptId } from "@usine/core/attempt";
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

/** A label an Attempt's Agent added to the Run's Item, as GitHub defines the label now. */
export class LabelAddedView extends Schema.TaggedClass<LabelAddedView>(
  "@usine/orchestrator/LabelAddedView",
)("LabelAdded", { at: Schema.String, label: LabelView }) {}

/** A label an Attempt's Agent removed from the Run's Item, as GitHub defines the label now. */
export class LabelRemovedView extends Schema.TaggedClass<LabelRemovedView>(
  "@usine/orchestrator/LabelRemovedView",
)("LabelRemoved", { at: Schema.String, label: LabelView }) {}

/** A comment an Attempt's Agent posted on the Run's Item; `url` opens it on GitHub. */
export class CommentedView extends Schema.TaggedClass<CommentedView>(
  "@usine/orchestrator/CommentedView",
)("Commented", { at: Schema.String, url: Schema.String }) {}

/** A review an Attempt's Agent submitted on the Run's pull request, with how it stands now. */
export class ReviewedView extends Schema.TaggedClass<ReviewedView>(
  "@usine/orchestrator/ReviewedView",
)("Reviewed", { at: Schema.String, url: Schema.String, state: ReviewState }) {}

/**
 * The operator moved the Run's Item between Board lanes while an Attempt was at work.
 * The factory wrote the label swap as the same App the Agent writes as; `at` is when
 * the operator made the move.
 */
export class BoardMovedView extends Schema.TaggedClass<BoardMovedView>(
  "@usine/orchestrator/BoardMovedView",
)("BoardMoved", { at: Schema.String, fromLane: LaneName, toLane: LaneName }) {}

/**
 * One change on the Run's GitHub Item while an Attempt was at work: a change the
 * Attempt's Agent made, `at` when GitHub recorded it, or the operator's Board move.
 */
export const GitHubChangeView = Schema.Union([
  LabelAddedView,
  LabelRemovedView,
  CommentedView,
  ReviewedView,
  BoardMovedView,
]);
export type GitHubChangeView = typeof GitHubChangeView.Type;

/** What changed on the Run's GitHub Item while one Attempt was at work, oldest first. */
export class AttemptGitHubChangesView extends Schema.Class<AttemptGitHubChangesView>(
  "@usine/orchestrator/AttemptGitHubChangesView",
)({ attemptId: AttemptId, changes: Schema.Array(GitHubChangeView) }) {}

/**
 * The GitHub changes of each of a Run's Attempts on the Run's Item, in Attempt order.
 * A Run without a GitHub Item, such as a schedule Run, lists no Attempts.
 */
export class RunGitHubChangesView extends Schema.Class<RunGitHubChangesView>(
  "@usine/orchestrator/RunGitHubChangesView",
)({ attempts: Schema.Array(AttemptGitHubChangesView) }) {}

export type RunGitHubChangesError = RunStoreError | GitHubAppError | GitHubItemNotFoundError;

/** Ended Attempts whose changes stay in memory; the oldest entries leave first. */
const CACHE_CAPACITY = 1_000;
/** GitHub's timeline can trail a write by seconds, so an Attempt is cached once it ended this long ago. */
const SETTLE_MILLIS = 60_000;
/** How far GitHub's clock may run behind the orchestrator's when it records a Board move's label change. */
const CLOCK_SKEW_MILLIS = 1_000;
/** A Board move's label writes all reach GitHub within this long after the move is recorded. */
const MOVE_SPAN_MILLIS = 10_000;

/** When an Attempt was at work on its Item; `end` is none while it runs. */
interface AttemptWindow {
  readonly attemptId: AttemptId;
  readonly start: number;
  readonly end: Option.Option<number>;
}

/**
 * Gives each change to the one Attempt whose window holds it. GitHub records times to
 * the second, so a window opens at the second its Attempt started. Every Agent writes
 * as the same App, so a change that two Attempts on the Item could each have made
 * belongs to neither.
 */
const attribute = (windows: ReadonlyArray<AttemptWindow>, changes: ReadonlyArray<ItemChange>) => {
  const attributed = new Map<AttemptId, Array<ItemChange>>();
  const ambiguous: Array<ItemChange> = [];
  for (const change of changes) {
    const at = DateTime.toEpochMillis(change.at);
    const holders = windows.filter(
      ({ start, end }) =>
        start - (start % 1_000) <= at &&
        Option.match(end, { onNone: () => true, onSome: (last) => at <= last }),
    );
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
 * Whether a recorded Board move made this label change: the move sent the same label
 * the same way, and GitHub recorded the change between the second the move was
 * recorded, less the clock skew, and the end of the move's span.
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
 * Splits the App's changes into the operator's Board moves that made some of them
 * and the changes no move made. A move with no change on the timeline, such as a
 * write GitHub refused, is left out.
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
  const windowOf = Effect.fn("RunGitHubChanges.windowOf")(function* (attempt: Attempt) {
    const start = DateTime.toEpochMillis(attempt.startedAt);
    const known = (end: Option.Option<number>): Option.Option<AttemptWindow> =>
      Option.some({ attemptId: attempt.id, start, end });
    if (Option.isNone(attempt.outcome)) return known(Option.none());
    if (Option.isSome(attempt.endedAt))
      return known(Option.some(DateTime.toEpochMillis(attempt.endedAt.value)));
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
    return known(Option.some(DateTime.toEpochMillis(last.receivedAt)));
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
    const windows = (yield* Effect.forEach([...onItem.values()], windowOf)).flatMap(Option.toArray);
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
      const earliest = Math.min(...placeable.map(({ start }) => start));
      const since = DateTime.makeUnsafe(earliest - (earliest % 1_000));
      // A move recorded shortly before the earliest window can still land in it.
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
              window.start <= at &&
              Option.match(window.end, { onNone: () => true, onSome: (last) => at <= last });
            return during ? [{ at, view: moveView(move) }] : [];
          }),
        ];
        fresh.set(
          window.attemptId,
          own.sort((left, right) => left.at - right.at).map(({ view }) => view),
        );
        if (Option.isSome(window.end) && now - window.end.value >= SETTLE_MILLIS)
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
 * What changed on the Run's GitHub Item while each of a Run's Attempts was at work:
 * the labels the Agent added and removed, its comments, and its reviews, all by the
 * factory's App, and the operator's Board moves. A label change that a recorded Board
 * move made is the operator's, never the Agent's; moves made before moves were
 * recorded read as the Agent's. A read asks GitHub once for the Attempts not yet
 * cached. An Attempt's changes are kept in memory a minute after it ends, after which
 * its window and GitHub's record no longer change.
 */
export class RunGitHubChanges extends Context.Service<
  RunGitHubChanges,
  {
    readonly read: (runId: RunId) => Effect.Effect<RunGitHubChangesView, RunGitHubChangesError>;
  }
>()("@usine/orchestrator/RunGitHubChanges") {
  static readonly layer = Layer.effect(RunGitHubChanges, makeRunGitHubChanges);
}
