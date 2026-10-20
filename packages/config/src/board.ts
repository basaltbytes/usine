import { Schema } from "effect";
import { nonBlankString } from "./checks.ts";
import { GitHubLabelName } from "./label.ts";

/** The operator-visible name of one lane on a Project's Board. */
export const LaneName = nonBlankString("Expected a non-blank lane name").pipe(
  Schema.brand("LaneName"),
);

export type LaneName = typeof LaneName.Type;

/** An issue or pull-request state that can place an Item in a Board lane. */
export const LaneItemState = Schema.Literals([
  "issue-open",
  "issue-closed",
  "pr-open",
  "pr-closed",
  "pr-merged",
]);

export type LaneItemState = typeof LaneItemState.Type;

const SETTLED_ITEM_STATES: ReadonlySet<LaneItemState> = new Set([
  "issue-closed",
  "pr-closed",
  "pr-merged",
]);

/**
 * Whether an Item in `state` is settled: a closed issue, or a closed or merged pull request.
 * The Board places a settled Item by its state alone, whatever labels it still carries, and a
 * lane whose sources are all settled states holds finished work.
 */
export const isSettledItemState = (state: LaneItemState): boolean => SETTLED_ITEM_STATES.has(state);

/** Places Items with this GitHub label in the lane; Board moves can write the label. */
export class LabelLaneSource extends Schema.Class<LabelLaneSource>("@usine/config/LabelLaneSource")(
  {
    label: GitHubLabelName,
  },
) {}

/** Places Items with this GitHub state in the lane; Board moves cannot change the state. */
export class StateLaneSource extends Schema.Class<StateLaneSource>("@usine/config/StateLaneSource")(
  {
    state: LaneItemState,
  },
) {}

/** A GitHub label or Item state that routes matching Items to a Board lane. */
export const LaneSource = Schema.Union([LabelLaneSource, StateLaneSource]);

export type LaneSource = typeof LaneSource.Type;

/** A named Board column containing Items that match any of its configured sources. */
export class Lane extends Schema.Class<Lane>("@usine/config/Lane")({
  name: LaneName,
  sources: Schema.Array(LaneSource).check(Schema.isNonEmpty()),
}) {}
