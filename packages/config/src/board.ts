import { Schema } from "effect";
import { nonBlankString } from "./checks.ts";
import { GitHubLabelName } from "./label.ts";

export const LaneName = nonBlankString("Expected a non-blank lane name").pipe(
  Schema.brand("LaneName"),
);

export type LaneName = typeof LaneName.Type;

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
 * Returns whether `state` is a closed issue or a closed or merged pull request, which the Board
 * places by state regardless of labels.
 */
export const isSettledItemState = (state: LaneItemState): state is SettledItemState =>
  isSettled(state);

/** A lane source that matches Items with this GitHub label, which Board moves can set. */
export class LabelLaneSource extends Schema.Class<LabelLaneSource>("@usine/config/LabelLaneSource")(
  {
    label: GitHubLabelName,
  },
) {}

/** A lane source that matches Items in this state, which Board moves can't change. */
export class StateLaneSource extends Schema.Class<StateLaneSource>("@usine/config/StateLaneSource")(
  {
    state: LaneItemState,
  },
) {}

export const LaneSource = Schema.Union([LabelLaneSource, StateLaneSource]);

export type LaneSource = typeof LaneSource.Type;

/** A Board column that contains the Items matching any of `sources`. */
export class Lane extends Schema.Class<Lane>("@usine/config/Lane")({
  name: LaneName,
  sources: Schema.Array(LaneSource).check(Schema.isNonEmpty()),
}) {}
