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
export type BoardLaneId = typeof BoardLaneId.Type;

/** The source of a lane: authored settings, a proposal, or default grouping. */
export const BoardLaneOrigin = Schema.Literals(["authored", "proposed", "fallback"]);
export type BoardLaneOrigin = typeof BoardLaneOrigin.Type;

/** An Item of a Task, with its own title and GitHub URL. */
export class BoardItemLink extends Schema.Class<BoardItemLink>("@usine/orchestrator/BoardItemLink")(
  {
    itemKey: ItemKey,
    kind: Schema.Literals(["issue", "pr"]),
    number: ItemNumber,
    title: Schema.String,
    url: Schema.NonEmptyString,
  },
) {}

/** An open or merged pull request of a Task. Closed, unmerged pull requests are excluded. */
export class BoardPullRequestView extends Schema.Class<BoardPullRequestView>(
  "@usine/orchestrator/BoardPullRequestView",
)({
  number: ItemNumber,
  url: Schema.NonEmptyString,
  state: Schema.Literals(["pr-open", "pr-merged"]),
}) {}

/**
 * A Board card for a Task projected from linked Items and placed by its current Item. While the
 * Task's newest open Run is running, the card stays in the lane that matched when the Run was
 * triggered.
 */
export class BoardTaskView extends Schema.Class<BoardTaskView>("@usine/orchestrator/BoardTaskView")(
  {
    ...BoardItemLink.fields,
    state: LaneItemState,
    labels: Schema.Array(GitHubLabelName),
    items: Schema.Array(BoardItemLink).check(Schema.isNonEmpty()),
    /**
     * The highest-numbered open pull request, else the highest-numbered merged one, or null if
     * there is neither.
     */
    pullRequest: Schema.NullOr(BoardPullRequestView),
    /** Every saved Run for the visible Items, earliest first. */
    runs: Schema.Array(RunView),
    run: Schema.NullOr(RunView),
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

/** An authored lane that the operator can move Items into by applying its GitHub labels. */
export class WritableBoardLaneView extends Schema.TaggedClass<WritableBoardLaneView>(
  "@usine/orchestrator/WritableBoardLaneView",
)("WritableBoardLane", {
  ...BoardLaneViewFields,
  origin: Schema.Literal("authored"),
  labels: Schema.Array(GitHubLabelName).check(Schema.isNonEmpty()),
}) {}

/** A lane that groups Items and doesn't accept moves. */
export class ReadOnlyBoardLaneView extends Schema.TaggedClass<ReadOnlyBoardLaneView>(
  "@usine/orchestrator/ReadOnlyBoardLaneView",
)("ReadOnlyBoardLane", BoardLaneViewFields) {}

/** A Board lane; only `WritableBoardLaneView` accepts operator moves. */
export const BoardLaneView = Schema.Union([WritableBoardLaneView, ReadOnlyBoardLaneView]);
export type BoardLaneView = typeof BoardLaneView.Type;

/** An Item that couldn't be projected as a Board card. Other Items are unaffected. */
export class BoardProjectionError extends Schema.TaggedError<BoardProjectionError>(
  "@usine/orchestrator/BoardProjectionError",
)("BoardProjectionError", {
  repository: RepositoryName,
  itemKey: ItemKey,
  message: Schema.NonEmptyString,
}) {}

/** The Project's lanes and the Item failures from building their cards. */
export class BoardView extends Schema.Class<BoardView>("@usine/orchestrator/BoardView")({
  lanes: Schema.Array(BoardLaneView),
  failures: Schema.Array(BoardProjectionError),
}) {}

/** A repository label. `color` is null for catalogs stored before colors were kept. */
export class LabelView extends Schema.Class<LabelView>("@usine/orchestrator/LabelView")({
  name: GitHubLabelName,
  color: Schema.NullOr(Schema.String),
  description: Schema.NullOr(Schema.String),
}) {}

/** An operator request to move one Project Item into a lane. */
export class BoardMove extends Schema.Class<BoardMove>("@usine/orchestrator/BoardMove")({
  repository: RepositoryName,
  item: ItemNumber,
  toLane: BoardLaneId,
}) {}

/** The requested Project isn't in the operator overview. */
export class BoardProjectNotFoundError extends Schema.TaggedError<BoardProjectNotFoundError>(
  "@usine/orchestrator/BoardProjectNotFoundError",
)("BoardProjectNotFoundError", {
  repository: RepositoryName,
}) {}

/** The requested Item isn't on the Project's Board. */
export class BoardItemNotFoundError extends Schema.TaggedError<BoardItemNotFoundError>(
  "@usine/orchestrator/BoardItemNotFoundError",
)("BoardItemNotFoundError", {
  repository: RepositoryName,
  item: ItemNumber,
}) {}

/** The requested destination lane isn't on the Project's Board. */
export class BoardLaneNotFoundError extends Schema.TaggedError<BoardLaneNotFoundError>(
  "@usine/orchestrator/BoardLaneNotFoundError",
)("BoardLaneNotFoundError", {
  repository: RepositoryName,
  lane: BoardLaneId,
}) {}

/** The requested destination lane doesn't accept label-based moves. */
export class BoardLaneReadOnlyError extends Schema.TaggedError<BoardLaneReadOnlyError>(
  "@usine/orchestrator/BoardLaneReadOnlyError",
)("BoardLaneReadOnlyError", {
  repository: RepositoryName,
  lane: BoardLaneId,
}) {}
