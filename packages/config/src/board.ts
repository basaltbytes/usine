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

export class LabelLaneSource extends Schema.Class<LabelLaneSource>("@usine/config/LabelLaneSource")(
  {
    label: GitHubLabelName,
  },
) {}

export class StateLaneSource extends Schema.Class<StateLaneSource>("@usine/config/StateLaneSource")(
  {
    state: LaneItemState,
  },
) {}

export const LaneSource = Schema.Union([LabelLaneSource, StateLaneSource]);

export type LaneSource = typeof LaneSource.Type;

export class Lane extends Schema.Class<Lane>("@usine/config/Lane")({
  name: LaneName,
  sources: Schema.Array(LaneSource).check(Schema.isNonEmpty()),
}) {}
