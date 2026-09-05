import { ItemKey, ItemNumber } from "@usine/core/item";
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

/** A Board card with the Item's GitHub state, labels, retained Runs, and intervention status. */
export class BoardItemView extends Schema.Class<BoardItemView>("@usine/orchestrator/BoardItemView")(
  {
    itemKey: ItemKey,
    kind: Schema.Literals(["issue", "pr"]),
    number: ItemNumber,
    title: Schema.String,
    url: Schema.NonEmptyString,
    state: LaneItemState,
    labels: Schema.Array(GitHubLabelName),
    /** Every retained Run for this card, each with the actions the operator can take on it. */
    runs: Schema.Array(RunView),
    run: Schema.NullOr(RunView),
    needsYou: Schema.Boolean,
  },
) {}

const BoardLaneViewFields = {
  id: BoardLaneId,
  name: LaneName,
  sources: Schema.Array(LaneSource),
  origin: BoardLaneOrigin,
  items: Schema.Array(BoardItemView),
} as const;

/** A lane the operator can move Items into by applying its configured GitHub labels. */
export class WritableBoardLaneView extends Schema.TaggedClass<WritableBoardLaneView>(
  "@usine/orchestrator/WritableBoardLaneView",
)("WritableBoardLane", {
  ...BoardLaneViewFields,
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
