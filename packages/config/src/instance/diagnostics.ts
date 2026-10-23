import { RepositoryName } from "@usine/core/repository";
import { Schema } from "effect";
import { LaneName } from "../board.ts";
import { GitHubLabelName } from "../label.ts";
import { LoopFile } from "../loop.ts";

export class UndeclaredLaneLabelWarning extends Schema.TaggedClass<UndeclaredLaneLabelWarning>(
  "@usine/config/UndeclaredLaneLabelWarning",
)("UndeclaredLaneLabelWarning", {
  repository: RepositoryName,
  lane: LaneName,
  label: GitHubLabelName,
}) {}

export class UndeclaredTriggerLabelWarning extends Schema.TaggedClass<UndeclaredTriggerLabelWarning>(
  "@usine/config/UndeclaredTriggerLabelWarning",
)("UndeclaredTriggerLabelWarning", {
  loop: LoopFile.fields.name,
  label: GitHubLabelName,
}) {}

/** The diagnostics that don't block a load. */
export const ConfigWarning = Schema.Union([
  UndeclaredLaneLabelWarning,
  UndeclaredTriggerLabelWarning,
]);

export type ConfigWarning = typeof ConfigWarning.Type;
