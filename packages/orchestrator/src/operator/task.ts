import {
  harvestedAttemptChanges,
  taskPullRequestState,
  TaskAttemptChangesView,
  TaskPullRequestState,
} from "./task-changes.ts";
import { LoopName } from "@usine/core/loop";
import { boardRepositories } from "@usine/config/project";
import { LaneName } from "@usine/config/board";
import type { LoadedInstance } from "@usine/config/instance";
import { GitHubLabelName } from "@usine/core/label";
import { ItemKey, ItemNumber } from "@usine/core/item";
import { canonicalRepositoryName, RepositoryName } from "@usine/core/repository";
import { RunId } from "@usine/core/run";
import { type Comment, CommentKind } from "@usine/core/step/result";
import { CycleBudgets } from "@usine/engine/cycle-budget";
import type { RunStoreError } from "@usine/engine/engine";
import { ItemProjectionReader } from "@usine/engine/item-projection";
import { LoopControl } from "@usine/engine/loop-control";
import { RepositoryLabelProjectionReader } from "@usine/engine/repository-label-projection";
import { type RunSnapshot, RunReader } from "@usine/engine/run-reader";
import {
  type Brand,
  Array as EffectArray,
  Context,
  DateTime,
  Effect,
  Layer,
  Option,
  Result,
  Schema,
} from "effect";
import { WorkerStatus } from "../worker-status.ts";
import { quotaWaits } from "./machines.ts";
import { readBoardItems } from "../board/selection.ts";
import { projectedItem } from "../board/items.ts";
import { projectBoard } from "../board/projection.ts";
import {
  BoardItemLink,
  BoardItemNotFoundError,
  BoardLaneId,
  BoardProjectNotFoundError,
} from "./board.ts";
import { readRunningEvents, runSummaryView, declaredWorkers } from "./projection.ts";
import { RunSummaryView } from "./run.ts";

/**
 * One issue or pull request of a Task, with its GitHub state as the Board card shows it.
 *
 * @property itemKey - The stored item identity, including its stream and repository.
 * @property kind - Whether this item is an issue or pull request.
 * @property number - The GitHub item number within its repository.
 * @property title - The last polled GitHub title.
 * @property url - The GitHub URL for the item.
 * @property state - The last polled issue or pull request state used for lane placement.
 */
export class TaskItemView extends Schema.Class<
  TaskItemView,
  Brand.Brand<"@usine/orchestrator/operator/task/TaskItemView">
>("@usine/orchestrator/TaskItemView")({
  ...BoardItemLink.fields,
  /** The last polled GitHub labels for this item. */
  labels: Schema.Array(GitHubLabelName),
  /** Whether the Item is an open pull request whose branch conflicts with its base. */
  conflicting: Schema.Boolean,
  /** Latest polled PR state; null for issues and older task responses. */
  pullRequest: Schema.NullOr(TaskPullRequestState).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
    Schema.withConstructorDefault(Effect.succeed(null)),
  ),
}) {}

/**
 * The Task's Board lane: its current Item's lane or, while a Run runs and the Item has no lane
 * label, the lane that Run was triggered from.
 */
export class TaskLaneView extends Schema.Class<
  TaskLaneView,
  Brand.Brand<"@usine/orchestrator/operator/task/TaskLaneView">
>("@usine/orchestrator/TaskLaneView")({
  /** The lane ID used by board move requests. */
  id: BoardLaneId,
  /** The display name of the task lane. */
  name: LaneName,
}) {}

/**
 * A comment or review an Attempt posted on its Run's Item. `postedAt` and `attemptEndedAt` are null
 * for records made before those times were stored.
 */
export class TaskCommentView extends Schema.Class<
  TaskCommentView,
  Brand.Brand<"@usine/orchestrator/operator/task/TaskCommentView">
>("@usine/orchestrator/TaskCommentView")({
  /** The run associated with this entry. */
  runId: RunId,
  /** Whether the attributed GitHub write is a comment or review. */
  kind: CommentKind,
  /** The GitHub URL of the comment or review. */
  url: Schema.String,
  /**
   * The GitHub posting time as an ISO 8601 timestamp, or null for older records without a posting
   * time.
   */
  postedAt: Schema.NullOr(Schema.String),
  /** The attributed attempt end time, or null if no end was recorded. */
  attemptEndedAt: Schema.NullOr(Schema.String),
}) {}

/**
 * One Task (ADR 0008). Tasks have no stored identity; `number` is the originating Item: the
 * earliest issue, or else the earliest pull request. A summary read leaves out `comments` and
 * `attemptChanges`, and a representation can hold one page of `runs`.
 */
export class TaskView extends Schema.Class<
  TaskView,
  Brand.Brand<"@usine/orchestrator/operator/task/TaskView">
>("@usine/orchestrator/TaskView")({
  /** The managed repo, in `owner/name` form. */
  repository: RepositoryName,
  /**
   * The originating issue number, or the earliest pull request number for tasks without an issue.
   */
  number: ItemNumber,
  /** The title of the originating item. */
  title: Schema.String,
  /**
   * The Item whose labels and state set the Task's lane (unless a running Run keeps it in its
   * trigger lane), and whose labels a Board move changes.
   */
  current: ItemKey,
  /** The board lane containing the task's current item. */
  lane: TaskLaneView,
  /**
   * Whether a Run on the Task's Items waits for approval or a failure decision, or an Item used up
   * its cycle budget.
   */
  needsYou: Schema.Boolean,
  /** Issues first, then pull requests, each by number; the first is the originating Item. */
  items: Schema.NonEmptyArray(TaskItemView),
  /**
   * The saved Runs on the Task's Items, newest first, without their task prompts and result text.
   * A paged representation holds only the newest Runs that fit its page.
   */
  runs: Schema.Array(RunSummaryView),
  /** The number of saved Runs on the Task's Items. */
  runsTotal: Schema.optionalKey(Schema.Int),
  /** Run identities for comments outside the first history page. */
  commentRuns: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({ id: RunId, repository: RepositoryName, itemKey: ItemKey, loop: LoopName }),
    ),
  ),
  /**
   * The harvested comments and reviews of every Run, newest Run first, and newest first within a
   * Run. Absent from a summary read.
   */
  comments: Schema.optionalKey(Schema.Array(TaskCommentView)),
  /**
   * Recorded attempt commit ranges of every Run, including attempts that pushed no new commits.
   * Absent from a summary read.
   */
  attemptChanges: Schema.optionalKey(Schema.Array(TaskAttemptChangesView)),
}) {}

/**
 * How much a task read returns: `summary` reads the Task's Items and Run summaries, and `results`
 * also reads every Run's results for its comments, reviews, and attempt commit ranges.
 */
export type TaskReadDepth = "summary" | "results";

/**
 * A task lookup failure caused by storage, an unknown repository, or an item outside the projected
 * board.
 */
export type TaskReadError = RunStoreError | BoardProjectNotFoundError | BoardItemNotFoundError;

const isoOrNull = Option.match({ onNone: () => null, onSome: DateTime.formatIso });

/**
 * Returns the comments and reviews that a Run's Attempts posted, newest first and without
 * duplicates.
 */
const harvestedComments = (summary: RunSnapshot): ReadonlyArray<TaskCommentView> => {
  const view = (comment: Comment, endedAt: Option.Option<DateTime.Utc>) =>
    TaskCommentView.make({
      runId: summary.run.id,
      kind: comment.kind,
      url: comment.url.toString(),
      postedAt: isoOrNull(comment.at),
      attemptEndedAt: isoOrNull(endedAt),
    });
  const succeededEnd = EffectArray.findLast(summary.attempts, (attempt) =>
    Option.exists(attempt.outcome, ({ _tag }) => _tag === "Succeeded"),
  ).pipe(Option.flatMap(({ endedAt }) => endedAt));
  const delivered = Option.match(summary.step.result, {
    onNone: () => [],
    onSome: ({ facts }) =>
      facts.flatMap((fact) => (fact._tag === "Comment" ? [view(fact, succeededEnd)] : [])),
  });
  const unsuccessful = summary.attempts.flatMap((attempt) =>
    attempt.comments.map((comment) => view(comment, attempt.endedAt)),
  );
  const time = ({ postedAt, attemptEndedAt }: TaskCommentView) => postedAt ?? attemptEndedAt ?? "";
  return EffectArray.dedupeWith(
    [...delivered, ...unsuccessful].sort((a, b) => time(b).localeCompare(time(a))),
    (a, b) => a.url === b.url,
  );
};

const makeTaskReader = Effect.gen(function* () {
  const reader = yield* RunReader;
  const workerStatus = yield* WorkerStatus;
  const controls = yield* LoopControl;
  const itemReader = yield* ItemProjectionReader;
  const repositoryLabels = yield* RepositoryLabelProjectionReader;
  const budgets = yield* CycleBudgets;

  const read = Effect.fn("TaskReader.read")(function* (
    instance: LoadedInstance,
    repository: RepositoryName,
    number: ItemNumber,
    depth: TaskReadDepth,
  ) {
    yield* Effect.annotateCurrentSpan({ repository, item: number, depth });
    const managed = boardRepositories(instance.config).find(
      ({ name }) => canonicalRepositoryName(name) === canonicalRepositoryName(repository),
    );
    if (managed === undefined) {
      yield* Effect.logInfo("Task read refused; the repository is not a registered Project", {
        repository,
        item: number,
      });
      return yield* BoardProjectNotFoundError.make({ repository });
    }
    const [stored, labelProjection, states, asks, provisioning] = yield* Effect.all(
      [
        reader
          .list({ closedLimit: 0 })
          .pipe(Effect.flatMap((runs) => readBoardItems(itemReader, managed.name, runs))),
        repositoryLabels.get(managed.name),
        controls.states,
        budgets.asks,
        workerStatus.provisioning,
      ] as const,
      { concurrency: "unbounded" },
    );
    const summaries = yield* reader.forItems(stored.map(({ itemKey }) => itemKey));
    const runEvents = yield* readRunningEvents(reader, summaries);
    const paused = new Set(states.filter((state) => state.paused).map((state) => state.loop));
    const runWorkers = declaredWorkers(instance.config.workers);
    const waits = quotaWaits(provisioning);
    const board = yield* projectBoard(
      managed,
      Option.match(labelProjection, {
        onNone: () => [],
        onSome: ({ labels }) => labels.map(({ name }) => name),
      }),
      stored,
      summaries.map((summary) => runSummaryView(summary, paused, runWorkers, waits)),
      asks.map(({ itemKey }) => itemKey),
      new Map(),
      new Map(),
      runEvents,
    );
    const placed = board.lanes
      .flatMap((lane) => lane.items.map((task) => ({ lane, task })))
      .find(({ task }) => task.items.some((member) => member.number === number));
    if (placed === undefined) {
      yield* Effect.logInfo("Task read found no task in the selected board items", {
        repository: managed.name,
        item: number,
        selectedItems: stored.length,
      });
      return yield* BoardItemNotFoundError.make({ repository: managed.name, item: number });
    }
    const { lane, task } = placed;
    const memberKeys = new Set(task.items.map(({ itemKey }) => itemKey));
    const projected = yield* Effect.forEach(
      stored.filter(({ itemKey }) => memberKeys.has(itemKey)),
      (item) => projectedItem(item).pipe(Effect.result),
    );
    const details = new Map<ItemKey, TaskItemView>();
    const storedByKey = new Map(stored.map((item) => [item.itemKey, item]));
    for (const result of projected) {
      if (Result.isFailure(result)) {
        yield* Effect.logError("Task Item could not be projected; the other Items are shown", {
          repository: managed.name,
          itemKey: result.failure.itemKey,
          message: result.failure.message,
        });
        continue;
      }
      const {
        itemKey,
        kind,
        number: itemNumber,
        title,
        url,
        state,
        labels,
        conflicting,
      } = result.success;
      const storedItem = storedByKey.get(itemKey);
      const pullRequest =
        kind === "pr" && storedItem !== undefined
          ? taskPullRequestState(storedItem.payload)
          : Option.none();
      if (kind === "pr" && Option.isNone(pullRequest))
        yield* Effect.logDebug(
          "Pull request changes unavailable without a valid projected base and head",
          { repository: managed.name, itemKey },
        );
      details.set(
        itemKey,
        TaskItemView.make({
          itemKey,
          kind,
          number: itemNumber,
          title,
          url,
          state,
          labels,
          conflicting,
          pullRequest: Option.getOrNull(pullRequest),
        }),
      );
    }
    const [first, ...rest] = task.items.flatMap(({ itemKey }) => {
      const detail = details.get(itemKey);
      return detail === undefined ? [] : [detail];
    });
    if (first === undefined) {
      return yield* BoardItemNotFoundError.make({ repository: managed.name, item: number });
    }
    const memberRuns = summaries
      .filter(({ itemKey }) => memberKeys.has(itemKey))
      .sort(
        (a, b) =>
          DateTime.toEpochMillis(b.run.openedAt) - DateTime.toEpochMillis(a.run.openedAt) ||
          b.run.id.localeCompare(a.run.id),
      );
    const runs = memberRuns.map((summary) => runSummaryView(summary, paused, runWorkers, waits));
    const summary = TaskView.make({
      repository: managed.name,
      number: first.number,
      title: task.title,
      current: task.itemKey,
      lane: TaskLaneView.make({ id: lane.id, name: lane.name }),
      needsYou: task.needsYou,
      items: [first, ...rest],
      runs,
      runsTotal: runs.length,
    });
    const fields = {
      repository: managed.name,
      item: number,
      depth,
      origin: summary.number,
      lane: lane.name,
      items: summary.items.length,
      runs: runs.length,
    };
    if (depth === "summary") {
      yield* Effect.logDebug("Read a Task", fields);
      return summary;
    }
    const inspected = yield* Effect.forEach(memberRuns, ({ run }) => reader.inspect(run.id), {
      concurrency: 4,
    });
    const comments = inspected.flatMap(harvestedComments);
    yield* Effect.logDebug("Read a Task", { ...fields, comments: comments.length });
    return TaskView.make({
      ...summary,
      comments,
      attemptChanges: inspected.flatMap(harvestedAttemptChanges),
    });
  });

  return { read } as const;
});

/**
 * Reads one task from the board projection over recent items and items with open runs.
 */
export class TaskReader extends Context.Service<
  TaskReader,
  {
    /**
     * Returns the Task that contains Item `item` of `repository`, read to `depth`. Fails if the
     * repository isn't a Project or the item isn't in the board selection.
     */
    readonly read: (
      instance: LoadedInstance,
      repository: RepositoryName,
      item: ItemNumber,
      depth: TaskReadDepth,
    ) => Effect.Effect<TaskView, TaskReadError>;
  }
>()("@usine/orchestrator/operator/task/TaskReader") {
  static readonly layer = Layer.effect(TaskReader, makeTaskReader);
}
