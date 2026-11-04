import { ItemKey, ItemNumber } from "@usine/core/item";
import { LoopName } from "@usine/core/loop";
import { RepositoryName } from "@usine/core/repository";
import { GitHubLabelName } from "@usine/config/label";
import { isSettledItemState, LaneItemState, LaneName, LaneSource } from "@usine/config/board";
import { type Brand, Effect, Schema } from "effect";
import { RunStateTag, RunSummaryView } from "./run.ts";
import { TaskUsageView } from "./usage.ts";

/** The ID of a lane on a Project's Board. */
export const BoardLaneId = Schema.NonEmptyString.pipe(Schema.brand("BoardLaneId"));
/** The ID of a lane on a project's board. */
export type BoardLaneId = typeof BoardLaneId.Type;

/** The source of a lane: authored settings, a proposal, or default grouping. */
export const BoardLaneOrigin = Schema.Literals(["authored", "proposed", "fallback"]);
/** The source of a lane: authored settings, a proposal, or default grouping. */
export type BoardLaneOrigin = typeof BoardLaneOrigin.Type;

/** An Item of a Task, with its own title, GitHub URL, and GitHub state. */
export class BoardItemLink extends Schema.Class<
  BoardItemLink,
  Brand.Brand<"@usine/orchestrator/operator/board/BoardItemLink">
>("@usine/orchestrator/BoardItemLink")({
  /** The stored item identity, including its stream and repository. */
  itemKey: ItemKey,
  /** Whether this item is an issue or pull request. */
  kind: Schema.Literals(["issue", "pr"]),
  /** The GitHub item number within its repository. */
  number: ItemNumber,
  /** The last polled GitHub title. */
  title: Schema.String,
  /** The GitHub URL for the item. */
  url: Schema.NonEmptyString,
  /** The last polled issue or pull request state used for lane placement. */
  state: LaneItemState,
  /** The last polled labels, including labels on non-current linked items. */
  labels: Schema.Array(GitHubLabelName).pipe(Schema.withConstructorDefault(Effect.succeed([]))),
  /** Whether this item is an open pull request with conflicts against its base. */
  conflicting: Schema.Boolean.pipe(Schema.withConstructorDefault(Effect.succeed(false))),
}) {}

/** An open or merged pull request of a Task. Closed, unmerged pull requests are excluded. */
export class BoardPullRequestView extends Schema.Class<
  BoardPullRequestView,
  Brand.Brand<"@usine/orchestrator/operator/board/BoardPullRequestView">
>("@usine/orchestrator/BoardPullRequestView")({
  /** The pull request number within its repository. */
  number: ItemNumber,
  /** The GitHub pull request URL. */
  url: Schema.NonEmptyString,
  /** Whether the selected pull request is open or merged. */
  state: Schema.Literals(["pr-open", "pr-merged"]),
}) {}

/**
 * A Board card for a Task projected from linked Items and placed by its current Item. While the
 * Task's newest open Run is running and the current Item has no lane label, the card stays in the
 * lane that matched when the Run was triggered.
 *
 * @property itemKey - The current item identity used for lane placement and board moves.
 * @property kind - Whether the current item is an issue or pull request.
 * @property number - The current item number within its repository.
 * @property title - The title of the originating issue, or earliest pull request without an issue.
 * @property url - The GitHub URL for the current item.
 * @property state - The last polled state of the current item, used for lane placement.
 */
export class BoardTaskView extends Schema.Class<
  BoardTaskView,
  Brand.Brand<"@usine/orchestrator/operator/board/BoardTaskView">
>("@usine/orchestrator/BoardTaskView")({
  ...BoardItemLink.fields,
  /** The managed repo, in `owner/name` form. */
  repository: RepositoryName,
  /** The current item labels used for lane placement. */
  labels: Schema.Array(GitHubLabelName),
  /** The linked issues and pull requests that form the task. */
  items: Schema.Array(BoardItemLink).check(Schema.isNonEmpty()),
  /**
   * The highest-numbered open pull request, else the highest-numbered merged one, or null if
   * there is neither.
   */
  pullRequest: Schema.NullOr(BoardPullRequestView),
  /** The number of saved runs across the task's items. */
  runCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  /** The number of attempts across every saved run. */
  attemptCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  /** Additional runs needed for current actions, latest activity, and CI handoffs. */
  runContext: Schema.Array(RunSummaryView),
  /** Each loop in first-run order, with its latest state. */
  loopStates: Schema.Array(Schema.Struct({ loop: LoopName, state: RunStateTag })),
  /**
   * The newest Run that needs the operator, else the open Run, else the newest Run, or null if
   * there are no Runs. A failed Run on a closed or merged Item doesn't need the operator.
   */
  run: Schema.NullOr(RunSummaryView),
  /** Whether a run or cycle-budget ask on the task needs operator attention. */
  needsYou: Schema.Boolean,
  /** Whether the current Item is an open pull request whose branch conflicts with its base. */
  conflicting: Schema.Boolean,
  /**
   * The Loops whose trigger currently matches one of the Task's Items, including paused Loops, in
   * Item order and then Loop order.
   */
  loops: Schema.Array(LoopName),
  /** The summed attempt time, tokens, and cost across every saved run. */
  usage: TaskUsageView,
}) {}

/** Returns the retained card summaries in run-opening order. Full history is on task detail. */
export const boardTaskRuns = (
  task: Pick<BoardTaskView, "run" | "runContext">,
): ReadonlyArray<RunSummaryView> =>
  [...task.runContext, ...(task.run === null ? [] : [task.run])].sort(
    (a, b) => a.openedAt.localeCompare(b.openedAt) || a.id.localeCompare(b.id),
  );

/** Summarizes task history while retaining runs that affect current actions and status. */
export const boardRunSummary = (
  runs: ReadonlyArray<RunSummaryView>,
  preferred: RunSummaryView | null,
  items: ReadonlyArray<BoardItemLink>,
  attentionRuns: ReadonlySet<RunSummaryView["id"]> = new Set(),
) => {
  const settled = new Set(
    items.filter(({ state }) => isSettledItemState(state)).map(({ itemKey }) => itemKey),
  );
  const latest = runs.at(-1);
  const retained = new Map(
    runs
      .filter(
        (run) =>
          attentionRuns.has(run.id) ||
          run.id === latest?.id ||
          run.canCancel ||
          (run.canResolveFailure && !settled.has(run.itemKey)),
      )
      .map((run) => [run.id, run]),
  );
  if (preferred !== null) retained.set(preferred.id, preferred);
  const newestFirst = [...runs].reverse();
  const contextualRuns = [...retained.values()];
  for (const run of contextualRuns) {
    const source = newestFirst.find(({ handoff }) => handoff?.fixRunId === run.id);
    if (source !== undefined) retained.set(source.id, source);
  }
  const states = new Map<LoopName, RunStateTag>();
  for (const { loop, state } of runs) states.set(loop, state);
  return {
    run: runs.find(({ id }) => id === preferred?.id) ?? preferred,
    runCount: runs.length,
    attemptCount: runs.reduce((count, run) => count + run.attempts.length, 0),
    runContext: [...retained.values()].filter(({ id }) => id !== preferred?.id),
    loopStates: [...states].map(([loop, state]) => ({ loop, state })),
  };
};

const BoardLaneViewFields = {
  id: BoardLaneId,
  name: LaneName,
  sources: Schema.Array(LaneSource),
  origin: BoardLaneOrigin,
  items: Schema.Array(BoardTaskView),
  /** Total cards when a lane is read in pages. */
  totalItems: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
} as const;

/**
 * An authored lane that the operator can move Items into by applying its GitHub labels.
 *
 * @property id - The lane ID used by board move requests.
 * @property name - The lane display name.
 * @property sources - The label and item-state sources used for task placement.
 * @property items - The task cards assigned to this lane.
 */
export class WritableBoardLaneView extends Schema.TaggedClass<
  WritableBoardLaneView,
  Brand.Brand<"@usine/orchestrator/operator/board/WritableBoardLaneView">
>("@usine/orchestrator/WritableBoardLaneView")("WritableBoardLane", {
  ...BoardLaneViewFields,
  /** Always `authored`; only configured label lanes accept moves. */
  origin: Schema.Literal("authored"),
  /** Labels added to the current item when moving the task into this lane. */
  labels: Schema.Array(GitHubLabelName).check(Schema.isNonEmpty()),
}) {}

/**
 * A lane that groups Items and doesn't accept moves.
 *
 * @property id - The lane ID used by board move requests.
 * @property name - The lane display name.
 * @property sources - The label and item-state sources used for task placement.
 * @property origin - Whether the lane is authored, proposed from labels, or the default unmapped
 * grouping.
 * @property items - The task cards assigned to this lane.
 */
export class ReadOnlyBoardLaneView extends Schema.TaggedClass<
  ReadOnlyBoardLaneView,
  Brand.Brand<"@usine/orchestrator/operator/board/ReadOnlyBoardLaneView">
>("@usine/orchestrator/ReadOnlyBoardLaneView")("ReadOnlyBoardLane", BoardLaneViewFields) {}

/** A Board lane; only `WritableBoardLaneView` accepts operator moves. */
export const BoardLaneView = Schema.Union([WritableBoardLaneView, ReadOnlyBoardLaneView]);
/** A board lane; only `WritableBoardLaneView` accepts operator moves. */
export type BoardLaneView = typeof BoardLaneView.Type;

/** An Item that couldn't be projected as a Board card. Other Items are unaffected. */
export class BoardProjectionError extends Schema.TaggedError<
  BoardProjectionError,
  Brand.Brand<"@usine/orchestrator/operator/board/BoardProjectionError">
>("@usine/orchestrator/BoardProjectionError")("BoardProjectionError", {
  /** The managed repo, in `owner/name` form. */
  repository: RepositoryName,
  /** The stored item identity, including its stream and repository. */
  itemKey: ItemKey,
  /** The diagnostic text to show to the operator. */
  message: Schema.NonEmptyString,
}) {}

/** The Project's lanes and the Item failures from building their cards. */
export class BoardView extends Schema.Class<
  BoardView,
  Brand.Brand<"@usine/orchestrator/operator/board/BoardView">
>("@usine/orchestrator/BoardView")({
  /** The configured or proposed lanes, including the unmapped lane when needed. */
  lanes: Schema.Array(BoardLaneView),
  /** All linked item keys with cards, including cards omitted from paginated lanes. */
  cardedItemKeys: Schema.optionalKey(Schema.Array(ItemKey)),
  /** Items excluded from projection because their stored data could not be decoded. */
  failures: Schema.Array(BoardProjectionError),
}) {}

/** A repository label. `color` is null for catalogs stored before colors were kept. */
export class LabelView extends Schema.Class<
  LabelView,
  Brand.Brand<"@usine/orchestrator/operator/board/LabelView">
>("@usine/orchestrator/LabelView")({
  /** The GitHub label name. */
  name: GitHubLabelName,
  /** The hexadecimal color without a leading hash, or null when unavailable. */
  color: Schema.NullOr(Schema.String),
  /** The GitHub label description, or null without one. */
  description: Schema.NullOr(Schema.String),
}) {}

/** An operator request to move one Project Item into a lane. */
export class BoardMove extends Schema.Class<
  BoardMove,
  Brand.Brand<"@usine/orchestrator/operator/board/BoardMove">
>("@usine/orchestrator/BoardMove")({
  /** The managed repo, in `owner/name` form. */
  repository: RepositoryName,
  /** The GitHub item number to move within the repository. */
  item: ItemNumber,
  /** The destination lane ID; it must identify a writable authored lane. */
  toLane: BoardLaneId,
}) {}

/** The requested Project isn't in the operator overview. */
export class BoardProjectNotFoundError extends Schema.TaggedError<
  BoardProjectNotFoundError,
  Brand.Brand<"@usine/orchestrator/operator/board/BoardProjectNotFoundError">
>("@usine/orchestrator/BoardProjectNotFoundError")("BoardProjectNotFoundError", {
  /** The managed repo, in `owner/name` form. */
  repository: RepositoryName,
}) {
  override get message() {
    return `Project "${this.repository}" was not found.`;
  }
}

/** The requested Item isn't on the Project's Board. */
export class BoardItemNotFoundError extends Schema.TaggedError<
  BoardItemNotFoundError,
  Brand.Brand<"@usine/orchestrator/operator/board/BoardItemNotFoundError">
>("@usine/orchestrator/BoardItemNotFoundError")("BoardItemNotFoundError", {
  /** The managed repo, in `owner/name` form. */
  repository: RepositoryName,
  /** The requested GitHub item number absent from the board. */
  item: ItemNumber,
}) {
  override get message() {
    return `Item ${this.repository}#${this.item} was not found on the board.`;
  }
}

/** The requested destination lane isn't on the Project's Board. */
export class BoardLaneNotFoundError extends Schema.TaggedError<
  BoardLaneNotFoundError,
  Brand.Brand<"@usine/orchestrator/operator/board/BoardLaneNotFoundError">
>("@usine/orchestrator/BoardLaneNotFoundError")("BoardLaneNotFoundError", {
  /** The managed repo, in `owner/name` form. */
  repository: RepositoryName,
  /** The requested destination lane ID. */
  lane: BoardLaneId,
}) {
  override get message() {
    return `Lane "${this.lane}" was not found on the board.`;
  }
}

/** The requested destination lane doesn't accept label-based moves. */
export class BoardLaneReadOnlyError extends Schema.TaggedError<
  BoardLaneReadOnlyError,
  Brand.Brand<"@usine/orchestrator/operator/board/BoardLaneReadOnlyError">
>("@usine/orchestrator/BoardLaneReadOnlyError")("BoardLaneReadOnlyError", {
  /** The managed repo, in `owner/name` form. */
  repository: RepositoryName,
  /** The requested destination lane ID. */
  lane: BoardLaneId,
}) {
  override get message() {
    return `Lane "${this.lane}" is read-only. To move items, configure label-backed lanes in usine.yaml.`;
  }
}
