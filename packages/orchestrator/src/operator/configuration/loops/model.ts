import { Stream } from "@usine/config/trigger";
import { LaneItemState } from "@usine/config/board";
import { ConfigProblem } from "@usine/config/file";
import { LoopFile, PriorityValue } from "@usine/config/loop";
import { ItemKey, ItemNumber } from "@usine/core/item";
import { RepositoryName } from "@usine/core/repository";
import { Schema } from "effect";

/** A loop draft identified by name, supplied as either form JSON or Markdown text. */
export const LoopDraft = Schema.Union([
  Schema.Struct({
    name: LoopFile.fields.name,
    value: Schema.Json,
    text: Schema.optionalKey(Schema.Never),
  }),
  Schema.Struct({
    name: LoopFile.fields.name,
    text: Schema.String,
    value: Schema.optionalKey(Schema.Never),
  }),
]);
/** A loop draft identified by name, supplied as either form JSON or Markdown text. */
export type LoopDraft = typeof LoopDraft.Type;
/** Validation problems in a loop draft. An empty list means validation passed. */
export class LoopCheck extends Schema.Class<LoopCheck>("LoopCheck")({
  /** Validation problems with field paths; empty when the draft is valid. */
  problems: Schema.Array(ConfigProblem),
}) {}
/**
 * A loop draft to evaluate against stored items without submitting runs, with an optional item for
 * prompt rendering.
 */
export class LoopPreviewRequest extends Schema.Class<LoopPreviewRequest>("LoopPreviewRequest")({
  /** The project-qualified loop identity used to validate the draft. */
  name: LoopFile.fields.name,
  /** The loop form JSON to validate and evaluate. */
  value: Schema.Json,
  /** The stored item for prompt rendering; omitted to render the first matching item. */
  itemKey: Schema.optionalKey(ItemKey),
}) {}
export class LoopPreviewItem extends Schema.Class<LoopPreviewItem>("LoopPreviewItem")({
  itemKey: ItemKey,
  repository: RepositoryName,
  kind: Schema.Literals(["issue", "pr"]),
  number: ItemNumber,
  title: Schema.String,
  url: Schema.String,
  state: LaneItemState,
  /** The evaluated queue priority; zero when evaluation fails. */
  priority: PriorityValue,
}) {}
/** Matching stored items and a rendered prompt for a loop draft, with per-item failures. */
export class LoopPreview extends Schema.Class<LoopPreview>("LoopPreview")({
  /** The draft trigger stream. */
  stream: Stream,
  /** Up to 20 matching stored issues or pull requests; schedule previews return no items. */
  items: Schema.Array(LoopPreviewItem),
  /** The total matching item count before the preview result limit. */
  total: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  /**
   * The rendered prompt for the requested item or first match, or null when no prompt could be
   * rendered.
   */
  prompt: Schema.NullOr(Schema.Struct({ itemKey: ItemKey, text: Schema.String })),
  /** Selected repositories without stored items for the trigger stream. */
  repositoriesWithoutItems: Schema.Array(RepositoryName),
  /** Per-item evaluation or prompt-rendering failures; other items still appear. */
  failures: Schema.Array(Schema.Struct({ itemKey: ItemKey, message: Schema.String })),
}) {}
