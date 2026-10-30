import { RepositoryName } from "@usine/core/repository";
import { Schema } from "effect";
import { LaneName } from "../board.ts";
import { GitHubLabelName } from "../label.ts";
import { LoopFile } from "../loop.ts";

/** A lane label absent from the instance's declared labels; this warning does not block loading. */
export class UndeclaredLaneLabelWarning extends Schema.TaggedClass<UndeclaredLaneLabelWarning>(
  "@usine/config/UndeclaredLaneLabelWarning",
)("UndeclaredLaneLabelWarning", {
  /** The managed repo whose board uses the lane. */
  repository: RepositoryName,
  /** The lane that references the undeclared label. */
  lane: LaneName,
  /** The label absent from the instance declarations. */
  label: GitHubLabelName,
}) {}

/**
 * A label literal in a loop condition absent from the instance's declared labels; this warning
 * does not block loading.
 */
export class UndeclaredTriggerLabelWarning extends Schema.TaggedClass<UndeclaredTriggerLabelWarning>(
  "@usine/config/UndeclaredTriggerLabelWarning",
)("UndeclaredTriggerLabelWarning", {
  /** The loop whose condition references the label. */
  loop: LoopFile.fields.name,
  /** The label literal absent from the instance declarations. */
  label: GitHubLabelName,
}) {}

/** The diagnostics that don't block a load. */
export const ConfigWarning = Schema.Union([
  UndeclaredLaneLabelWarning,
  UndeclaredTriggerLabelWarning,
]);

export type ConfigWarning = typeof ConfigWarning.Type;
