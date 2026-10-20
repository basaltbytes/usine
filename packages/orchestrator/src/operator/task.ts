import { LaneItemState, LaneName } from "@usine/config/board";
import type { LoadedInstance } from "@usine/config/instance";
import { GitHubLabelName } from "@usine/config/label";
import { ItemKey, ItemNumber } from "@usine/core/item";
import { canonicalRepositoryName, RepositoryName } from "@usine/core/repository";
import { RunId } from "@usine/core/run";
import { type Comment, CommentKind } from "@usine/core/step/result";
import { CycleBudgets } from "@usine/engine/cycle-budget";
import type { RunStoreError } from "@usine/engine/engine";
import { ItemProjectionReader } from "@usine/engine/item-projection";
import { LoopControl } from "@usine/engine/loop-control";
import { RepositoryLabelProjectionReader } from "@usine/engine/repository-label-projection";
import { type RunSummary, RunReader } from "@usine/engine/run-reader";
import {
  Array as EffectArray,
  Context,
  DateTime,
  Effect,
  Layer,
  Option,
  Result,
  Schema,
} from "effect";
import { projectedItem } from "../board/items.ts";
import { projectBoard } from "../board/projection.ts";
import {
  BoardItemLink,
  BoardItemNotFoundError,
  BoardLaneId,
  BoardProjectNotFoundError,
} from "./board.ts";
import { runView } from "./projection.ts";
import { RunView } from "./run.ts";

/** How many newest Items the Board, and so a Task's membership, considers; older ones drop off. */
const TASK_BOARD_ITEMS = 500;

/** One issue or pull request of a Task, with how it stands on GitHub as the Board card shows it. */
export class TaskItemView extends Schema.Class<TaskItemView>("@usine/orchestrator/TaskItemView")({
  ...BoardItemLink.fields,
  state: LaneItemState,
  labels: Schema.Array(GitHubLabelName),
  /** An open pull request whose branch conflicts with its base. */
  conflicting: Schema.Boolean,
}) {}

/** The Board lane a Task sits in, placed by its current Item. */
export class TaskLaneView extends Schema.Class<TaskLaneView>("@usine/orchestrator/TaskLaneView")({
  id: BoardLaneId,
  name: LaneName,
}) {}

/**
 * A comment or review an Attempt posted on its Run's Item, from the Run's harvested
 * `Comment` facts. Only a succeeded Attempt records facts, so `at` is when that Attempt
 * ended; null for an Attempt closed before end times were recorded.
 */
export class TaskCommentView extends Schema.Class<TaskCommentView>(
  "@usine/orchestrator/TaskCommentView",
)({
  runId: RunId,
  kind: CommentKind,
  url: Schema.String,
  at: Schema.NullOr(Schema.String),
}) {}

/**
 * One Task as its page shows it (ADR 0024): its Items, every saved Run on them, and the
 * comments and reviews its Runs posted. The Task has no stored identity; `number` is its
 * originating Item, the earliest issue or, without one, the earliest pull request.
 */
export class TaskView extends Schema.Class<TaskView>("@usine/orchestrator/TaskView")({
  repository: RepositoryName,
  number: ItemNumber,
  title: Schema.String,
  /** The Item whose labels and state place the Task in its lane, and whose labels a Board move changes. */
  current: ItemKey,
  lane: TaskLaneView,
  /** A Run on one of its Items waits for approval or a failure decision, or an Item used up its cycle budget. */
  needsYou: Schema.Boolean,
  /** Issues first, then pull requests, each by number; the first is the originating Item. */
  items: Schema.NonEmptyArray(TaskItemView),
  /** Every saved Run on the Task's Items, newest first. */
  runs: Schema.Array(RunView),
  /** The harvested comments and reviews of those Runs, newest Run first. */
  comments: Schema.Array(TaskCommentView),
}) {}

export type TaskReadError = RunStoreError | BoardProjectNotFoundError | BoardItemNotFoundError;

const harvestedComments = (summary: RunSummary): ReadonlyArray<TaskCommentView> => {
  const facts = Option.match(summary.step.result, {
    onNone: () => [],
    onSome: ({ facts }) => facts.filter((fact): fact is Comment => fact._tag === "Comment"),
  });
  if (facts.length === 0) return [];
  const at = EffectArray.findLast(summary.attempts, (attempt) =>
    Option.exists(attempt.outcome, ({ _tag }) => _tag === "Succeeded"),
  ).pipe(
    Option.flatMap(({ endedAt }) => endedAt),
    Option.match({ onNone: () => null, onSome: DateTime.formatIso }),
  );
  return facts.map(
    ({ kind, url }) =>
      new TaskCommentView({ runId: summary.run.id, kind, url: url.toString(), at }),
  );
};

const makeTaskReader = Effect.gen(function* () {
  const reader = yield* RunReader;
  const controls = yield* LoopControl;
  const itemReader = yield* ItemProjectionReader;
  const repositoryLabels = yield* RepositoryLabelProjectionReader;
  const budgets = yield* CycleBudgets;

  const read = Effect.fn("TaskReader.read")(function* (
    instance: LoadedInstance,
    repository: RepositoryName,
    number: ItemNumber,
  ) {
    yield* Effect.annotateCurrentSpan({ repository, item: number });
    const managed = instance.config.repos.find(
      ({ name }) => canonicalRepositoryName(name) === canonicalRepositoryName(repository),
    );
    if (managed === undefined) {
      yield* Effect.logInfo("Task read refused; the repository is not a registered Project", {
        repository,
        item: number,
      });
      return yield* new BoardProjectNotFoundError({ repository });
    }
    const [stored, labelProjection, states, asks] = yield* Effect.all(
      [
        itemReader.list(managed.name, { limit: TASK_BOARD_ITEMS }),
        repositoryLabels.get(managed.name),
        controls.states,
        budgets.asks(),
      ] as const,
      { concurrency: "unbounded" },
    );
    const summaries = yield* reader.forItems(stored.map(({ itemKey }) => itemKey));
    const paused = new Set(states.filter((state) => state.paused).map((state) => state.loop));
    const board = yield* projectBoard(
      managed,
      Option.match(labelProjection, {
        onNone: () => [],
        onSome: ({ labels }) => labels.map(({ name }) => name),
      }),
      stored,
      summaries.map((summary) => runView(summary, paused)),
      asks.map(({ itemKey }) => itemKey),
    );
    const placed = board.lanes
      .flatMap((lane) => lane.items.map((task) => ({ lane, task })))
      .find(({ task }) => task.items.some((member) => member.number === number));
    if (placed === undefined) {
      yield* Effect.logInfo(
        "Task read found no Task; the Item is not among the Project's newest Board Items",
        { repository: managed.name, item: number, window: TASK_BOARD_ITEMS },
      );
      return yield* new BoardItemNotFoundError({ repository: managed.name, item: number });
    }
    const { lane, task } = placed;
    const memberKeys = new Set(task.items.map(({ itemKey }) => itemKey));
    const projected = yield* Effect.forEach(
      stored.filter(({ itemKey }) => memberKeys.has(itemKey)),
      (item) => projectedItem(item).pipe(Effect.result),
    );
    const details = new Map<ItemKey, TaskItemView>();
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
      details.set(
        itemKey,
        new TaskItemView({
          itemKey,
          kind,
          number: itemNumber,
          title,
          url,
          state,
          labels,
          conflicting,
        }),
      );
    }
    const [first, ...rest] = task.items.flatMap(({ itemKey }) => {
      const detail = details.get(itemKey);
      return detail === undefined ? [] : [detail];
    });
    if (first === undefined) {
      return yield* new BoardItemNotFoundError({ repository: managed.name, item: number });
    }
    const taskRuns = new Set(task.runs.map(({ id }) => id));
    const comments = summaries
      .filter(({ run }) => taskRuns.has(run.id))
      .sort(
        (a, b) =>
          DateTime.toEpochMillis(b.run.openedAt) - DateTime.toEpochMillis(a.run.openedAt) ||
          b.run.id.localeCompare(a.run.id),
      )
      .flatMap(harvestedComments);
    const view = new TaskView({
      repository: managed.name,
      number: first.number,
      title: task.title,
      current: task.itemKey,
      lane: new TaskLaneView({ id: lane.id, name: lane.name }),
      needsYou: task.needsYou,
      items: [first, ...rest],
      runs: [...task.runs].reverse(),
      comments,
    });
    yield* Effect.logDebug("Read a Task", {
      repository: managed.name,
      item: number,
      origin: view.number,
      lane: lane.name,
      items: view.items.length,
      runs: view.runs.length,
      comments: comments.length,
    });
    return view;
  });

  return { read } as const;
});

/**
 * Reads one Task: its membership and lane come from the Board projection over the Project's
 * newest Items, and its Runs from every saved Run of those Items.
 */
export class TaskReader extends Context.Service<
  TaskReader,
  {
    /**
     * The Task that holds Item `item` of `repository`, found from any of its Items. Fails when the
     * repository is not a Project or the Item is not among the Board's newest Items.
     */
    readonly read: (
      instance: LoadedInstance,
      repository: RepositoryName,
      item: ItemNumber,
    ) => Effect.Effect<TaskView, TaskReadError>;
  }
>()("@usine/orchestrator/TaskReader") {
  static readonly layer = Layer.effect(TaskReader, makeTaskReader);
}
