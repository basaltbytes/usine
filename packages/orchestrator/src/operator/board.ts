import { ItemKey, ItemNumber } from "@usine/core/item";
import { LoopName } from "@usine/core/loop";
import { RepositoryName } from "@usine/core/repository";
import { GitHubLabelName } from "@usine/config/label";
import { LaneItemState, LaneName, LaneSource } from "@usine/config/board";
import { Schema } from "effect";
import { RunView } from "./run.ts";
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
export class BoardItemLink extends Schema.Class<BoardItemLink>("@usine/orchestrator/BoardItemLink")(
  {
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
  },
) {}

/** An open or merged pull request of a Task. Closed, unmerged pull requests are excluded. */
export class BoardPullRequestView extends Schema.Class<BoardPullRequestView>(
  "@usine/orchestrator/BoardPullRequestView",
)({
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
export class BoardTaskView extends Schema.Class<BoardTaskView>("@usine/orchestrator/BoardTaskView")(
  {
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
    /** Every saved Run for the visible Items, earliest first. */
    runs: Schema.Array(RunView),
    /**
     * The newest Run that needs the operator, else the open Run, else the newest Run, or null if
     * there are no Runs. A failed Run on a closed or merged Item doesn't need the operator.
     */
    run: Schema.NullOr(RunView),
    /** Whether a run or cycle-budget ask on the task needs operator attention. */
    needsYou: Schema.Boolean,
    /** Whether the current Item is an open pull request whose branch conflicts with its base. */
    conflicting: Schema.Boolean,
    /**
     * The Loops whose trigger currently matches one of the Task's Items, including paused Loops, in
     * Item order and then Loop order.
     */
    loops: Schema.Array(LoopName),
    /** The summed Attempt time, tokens, and cost of `runs`. */
    usage: TaskUsageView,
  },
) {}

const BoardLaneViewFields = {
  id: BoardLaneId,
  name: LaneName,
  sources: Schema.Array(LaneSource),
  origin: BoardLaneOrigin,
  items: Schema.Array(BoardTaskView),
} as const;

/**
 * An authored lane that the operator can move Items into by applying its GitHub labels.
 *
 * @property id - The lane ID used by board move requests.
 * @property name - The lane display name.
 * @property sources - The label and item-state sources used for task placement.
 * @property items - The task cards assigned to this lane.
 */
export class WritableBoardLaneView extends Schema.TaggedClass<WritableBoardLaneView>(
  "@usine/orchestrator/WritableBoardLaneView",
)("WritableBoardLane", {
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
export class ReadOnlyBoardLaneView extends Schema.TaggedClass<ReadOnlyBoardLaneView>(
  "@usine/orchestrator/ReadOnlyBoardLaneView",
)("ReadOnlyBoardLane", BoardLaneViewFields) {}

/** A Board lane; only `WritableBoardLaneView` accepts operator moves. */
export const BoardLaneView = Schema.Union([WritableBoardLaneView, ReadOnlyBoardLaneView]);
/** A board lane; only `WritableBoardLaneView` accepts operator moves. */
export type BoardLaneView = typeof BoardLaneView.Type;

/** An Item that couldn't be projected as a Board card. Other Items are unaffected. */
export class BoardProjectionError extends Schema.TaggedError<BoardProjectionError>(
  "@usine/orchestrator/BoardProjectionError",
)("BoardProjectionError", {
  /** The managed repo, in `owner/name` form. */
  repository: RepositoryName,
  /** The stored item identity, including its stream and repository. */
  itemKey: ItemKey,
  /** The diagnostic text to show to the operator. */
  message: Schema.NonEmptyString,
}) {}

/** The Project's lanes and the Item failures from building their cards. */
export class BoardView extends Schema.Class<BoardView>("@usine/orchestrator/BoardView")({
  /** The configured or proposed lanes, including the unmapped lane when needed. */
  lanes: Schema.Array(BoardLaneView),
  /** Items excluded from projection because their stored data could not be decoded. */
  failures: Schema.Array(BoardProjectionError),
}) {}

/** A repository label. `color` is null for catalogs stored before colors were kept. */
export class LabelView extends Schema.Class<LabelView>("@usine/orchestrator/LabelView")({
  /** The GitHub label name. */
  name: GitHubLabelName,
  /** The hexadecimal color without a leading hash, or null when unavailable. */
  color: Schema.NullOr(Schema.String),
  /** The GitHub label description, or null without one. */
  description: Schema.NullOr(Schema.String),
}) {}

/** An operator request to move one Project Item into a lane. */
export class BoardMove extends Schema.Class<BoardMove>("@usine/orchestrator/BoardMove")({
  /** The managed repo, in `owner/name` form. */
  repository: RepositoryName,
  /** The GitHub item number to move within the repository. */
  item: ItemNumber,
  /** The destination lane ID; it must identify a writable authored lane. */
  toLane: BoardLaneId,
}) {}

/** The requested Project isn't in the operator overview. */
export class BoardProjectNotFoundError extends Schema.TaggedError<BoardProjectNotFoundError>(
  "@usine/orchestrator/BoardProjectNotFoundError",
)("BoardProjectNotFoundError", {
  /** The managed repo, in `owner/name` form. */
  repository: RepositoryName,
}) {
  override get message() {
    return `Project "${this.repository}" was not found.`;
  }
}

/** The requested Item isn't on the Project's Board. */
export class BoardItemNotFoundError extends Schema.TaggedError<BoardItemNotFoundError>(
  "@usine/orchestrator/BoardItemNotFoundError",
)("BoardItemNotFoundError", {
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
export class BoardLaneNotFoundError extends Schema.TaggedError<BoardLaneNotFoundError>(
  "@usine/orchestrator/BoardLaneNotFoundError",
)("BoardLaneNotFoundError", {
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
export class BoardLaneReadOnlyError extends Schema.TaggedError<BoardLaneReadOnlyError>(
  "@usine/orchestrator/BoardLaneReadOnlyError",
)("BoardLaneReadOnlyError", {
  /** The managed repo, in `owner/name` form. */
  repository: RepositoryName,
  /** The requested destination lane ID. */
  lane: BoardLaneId,
}) {
  override get message() {
    return `Lane "${this.lane}" is read-only. To move items, configure label-backed lanes in usine.yaml.`;
  }
}
