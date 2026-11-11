import { RepositoryName } from "@usine/core/repository";
import { type Brand, Schema } from "effect";
import { LaneName } from "../board.ts";
import { GitHubLabelName } from "@usine/core/label";
import { LoopFile } from "../loop.ts";

/** A lane label absent from the instance's declared labels; this warning does not block loading. */
export class UndeclaredLaneLabelWarning extends Schema.TaggedClass<
  UndeclaredLaneLabelWarning,
  Brand.Brand<"@usine/config/instance/diagnostics/UndeclaredLaneLabelWarning">
>("@usine/config/UndeclaredLaneLabelWarning")("UndeclaredLaneLabelWarning", {
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
export class UndeclaredTriggerLabelWarning extends Schema.TaggedClass<
  UndeclaredTriggerLabelWarning,
  Brand.Brand<"@usine/config/instance/diagnostics/UndeclaredTriggerLabelWarning">
>("@usine/config/UndeclaredTriggerLabelWarning")("UndeclaredTriggerLabelWarning", {
  /** The loop whose condition references the label. */
  loop: LoopFile.fields.name,
  /** The label literal absent from the instance declarations. */
  label: GitHubLabelName,
}) {}

/**
 * A loop's outcome label absent from the instance's declared labels; this warning does not block
 * loading. An agent can't apply a label that the repository doesn't have, so the loop's runs fail
 * their completion check.
 */
export class UndeclaredOutcomeLabelWarning extends Schema.TaggedClass<
  UndeclaredOutcomeLabelWarning,
  Brand.Brand<"@usine/config/instance/diagnostics/UndeclaredOutcomeLabelWarning">
>("@usine/config/UndeclaredOutcomeLabelWarning")("UndeclaredOutcomeLabelWarning", {
  /** The loop that requires the label. */
  loop: LoopFile.fields.name,
  /** The outcome label absent from the instance declarations. */
  label: GitHubLabelName,
}) {}

/** The diagnostics that don't block a load. */
export const ConfigWarning = Schema.Union([
  UndeclaredLaneLabelWarning,
  UndeclaredTriggerLabelWarning,
  UndeclaredOutcomeLabelWarning,
]);

export type ConfigWarning = typeof ConfigWarning.Type;
