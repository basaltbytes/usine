import { Schema } from "effect";
import { nonBlankString } from "./checks.ts";
import { GitHubLabelName } from "./label.ts";

/** A nonblank display name that identifies a lane within its project. */
export const LaneName = nonBlankString("Expected a non-blank lane name").pipe(
  Schema.brand("LaneName"),
);

export type LaneName = typeof LaneName.Type;

/** An issue or pull request state that a lane can match. */
export const LaneItemState = Schema.Literals([
  "issue-open",
  "issue-closed",
  "pr-open",
  "pr-closed",
  "pr-merged",
]);

export type LaneItemState = typeof LaneItemState.Type;

/** The state of a closed issue or a closed or merged pull request. */
export const SettledItemState = Schema.Literals(["issue-closed", "pr-closed", "pr-merged"]);

export type SettledItemState = typeof SettledItemState.Type;

const isSettled = Schema.is(SettledItemState);

/**
 * Returns whether `state` is a closed issue or a closed or merged pull request, which the board
 * places by state regardless of labels.
 */
export const isSettledItemState = (state: LaneItemState): state is SettledItemState =>
  isSettled(state);

/** A lane source that matches items with this GitHub label, which board moves can set. */
export class LabelLaneSource extends Schema.Class<LabelLaneSource>("@usine/config/LabelLaneSource")(
  {
    /** The GitHub label to match; comparisons ignore case. */
    label: GitHubLabelName,
  },
) {}

/** A lane source that matches items in this state, which board moves can't change. */
export class StateLaneSource extends Schema.Class<StateLaneSource>("@usine/config/StateLaneSource")(
  {
    /** The issue or pull request state to match independently of labels. */
    state: LaneItemState,
  },
) {}

/** A label or item state used to select items for a lane. */
export const LaneSource = Schema.Union([LabelLaneSource, StateLaneSource]);

export type LaneSource = typeof LaneSource.Type;

/** A board lane that contains the items matching any of `sources`. */
export class Lane extends Schema.Class<Lane>("@usine/config/Lane")({
  /** The display name, unique within the project lane map. */
  name: LaneName,
  /** The nonempty set of label or state matches; an item can match any source. */
  sources: Schema.Array(LaneSource).check(Schema.isNonEmpty()),
}) {}
