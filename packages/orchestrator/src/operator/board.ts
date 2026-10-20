import { ItemKey, ItemNumber } from "@usine/core/item";
import { LoopName } from "@usine/core/loop";
import { RepositoryName } from "@usine/core/repository";
import { GitHubLabelName } from "@usine/config/label";
import { LaneItemState, LaneName, LaneSource } from "@usine/config/board";
import { Schema } from "effect";
import { RunView } from "./run.ts";

/** Identifies a lane within a Project's Board for operator moves. */
export const BoardLaneId = Schema.NonEmptyString.pipe(Schema.brand("BoardLaneId"));
export type BoardLaneId = typeof BoardLaneId.Type;

/** Whether a lane came from authored settings, a proposal, or default grouping. */
export const BoardLaneOrigin = Schema.Literals(["authored", "proposed", "fallback"]);
export type BoardLaneOrigin = typeof BoardLaneOrigin.Type;

/** An Item linked to a Task, with its own title and external destination. */
export class BoardItemLink extends Schema.Class<BoardItemLink>("@usine/orchestrator/BoardItemLink")(
  {
    itemKey: ItemKey,
    kind: Schema.Literals(["issue", "pr"]),
    number: ItemNumber,
    title: Schema.String,
    url: Schema.NonEmptyString,
  },
) {}

/** A pull request of a Task that is open or merged; a closed, unmerged one is never named. */
export class BoardPullRequestView extends Schema.Class<BoardPullRequestView>(
  "@usine/orchestrator/BoardPullRequestView",
)({
  number: ItemNumber,
  url: Schema.NonEmptyString,
  state: Schema.Literals(["pr-open", "pr-merged"]),
}) {}

/** A Task projected from linked Items. The current Item determines the key, lane, labels, and move destination; the first issue supplies the Task title. */
export class BoardTaskView extends Schema.Class<BoardTaskView>("@usine/orchestrator/BoardTaskView")(
  {
    ...BoardItemLink.fields,
    state: LaneItemState,
    /** When GitHub last updated the current Item, as the poll stored it: an ISO 8601 UTC time. */
    updatedAt: Schema.String,
    labels: Schema.Array(GitHubLabelName),
    items: Schema.Array(BoardItemLink).check(Schema.isNonEmpty()),
    /**
     * The Task's open pull request, the highest-numbered one when several are open; without
     * one, its highest-numbered merged pull request; null when it has neither.
     */
    pullRequest: Schema.NullOr(BoardPullRequestView),
    /** Every saved Run for the visible Items, ordered from earliest to latest. */
    runs: Schema.Array(RunView),
    run: Schema.NullOr(RunView),
    needsYou: Schema.Boolean,
    /** The current Item is an open pull request whose branch conflicts with its base. */
    conflicting: Schema.Boolean,
    /**
     * The Loops whose trigger matches one of the Task's Items now, as the poll evaluates
     * it, paused Loops included: in the order of the Task's Items, then of the instance's
     * Loops. Empty when no Loop's trigger matches the Task as it is.
     */
    loops: Schema.Array(LoopName),
  },
) {}

const BoardLaneViewFields = {
  id: BoardLaneId,
  name: LaneName,
  sources: Schema.Array(LaneSource),
  origin: BoardLaneOrigin,
  items: Schema.Array(BoardTaskView),
} as const;

/** An authored lane the operator can move Items into by applying its configured GitHub labels. */
export class WritableBoardLaneView extends Schema.TaggedClass<WritableBoardLaneView>(
  "@usine/orchestrator/WritableBoardLaneView",
)("WritableBoardLane", {
  ...BoardLaneViewFields,
  origin: Schema.Literal("authored"),
  labels: Schema.Array(GitHubLabelName).check(Schema.isNonEmpty()),
}) {}

/** A lane that groups Items without accepting label-based moves. */
export class ReadOnlyBoardLaneView extends Schema.TaggedClass<ReadOnlyBoardLaneView>(
  "@usine/orchestrator/ReadOnlyBoardLaneView",
)("ReadOnlyBoardLane", BoardLaneViewFields) {}

/** A displayed lane whose variant determines whether operator moves are supported. */
export const BoardLaneView = Schema.Union([WritableBoardLaneView, ReadOnlyBoardLaneView]);
export type BoardLaneView = typeof BoardLaneView.Type;

/** An Item projection could not produce a Board card; other Items remain available. */
export class BoardProjectionError extends Schema.TaggedError<BoardProjectionError>(
  "@usine/orchestrator/BoardProjectionError",
)("BoardProjectionError", {
  repository: RepositoryName,
  itemKey: ItemKey,
  message: Schema.NonEmptyString,
}) {}

/** The Project's lanes and the Item failures encountered while constructing their cards. */
export class BoardView extends Schema.Class<BoardView>("@usine/orchestrator/BoardView")({
  lanes: Schema.Array(BoardLaneView),
  failures: Schema.Array(BoardProjectionError),
}) {}

/** A repository label as GitHub shows it. Color is null for catalogs stored before colors were kept. */
export class LabelView extends Schema.Class<LabelView>("@usine/orchestrator/LabelView")({
  name: GitHubLabelName,
  color: Schema.NullOr(Schema.String),
  description: Schema.NullOr(Schema.String),
}) {}

/** An operator request to move one Project Item into a destination lane. */
export class BoardMove extends Schema.Class<BoardMove>("@usine/orchestrator/BoardMove")({
  repository: RepositoryName,
  item: ItemNumber,
  toLane: BoardLaneId,
}) {}

/** The requested Project is absent from the operator overview. */
export class BoardProjectNotFoundError extends Schema.TaggedError<BoardProjectNotFoundError>(
  "@usine/orchestrator/BoardProjectNotFoundError",
)("BoardProjectNotFoundError", {
  repository: RepositoryName,
}) {}

/** The requested Item is absent from the Project's Board. */
export class BoardItemNotFoundError extends Schema.TaggedError<BoardItemNotFoundError>(
  "@usine/orchestrator/BoardItemNotFoundError",
)("BoardItemNotFoundError", {
  repository: RepositoryName,
  item: ItemNumber,
}) {}

/** The requested destination lane is absent from the Project's Board. */
export class BoardLaneNotFoundError extends Schema.TaggedError<BoardLaneNotFoundError>(
  "@usine/orchestrator/BoardLaneNotFoundError",
)("BoardLaneNotFoundError", {
  repository: RepositoryName,
  lane: BoardLaneId,
}) {}

/** The requested destination lane does not accept label-based moves. */
export class BoardLaneReadOnlyError extends Schema.TaggedError<BoardLaneReadOnlyError>(
  "@usine/orchestrator/BoardLaneReadOnlyError",
)("BoardLaneReadOnlyError", {
  repository: RepositoryName,
  lane: BoardLaneId,
}) {}
