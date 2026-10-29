import { Stream } from "@usine/config/trigger";
import { LaneItemState } from "@usine/config/board";
import { ConfigProblem } from "@usine/config/file";
import { LoopFile } from "@usine/config/loop";
import { ItemKey, ItemNumber } from "@usine/core/item";
import { RepositoryName } from "@usine/core/repository";
import { Schema } from "effect";

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
export type LoopDraft = typeof LoopDraft.Type;
export class LoopCheck extends Schema.Class<LoopCheck>("LoopCheck")({
  problems: Schema.Array(ConfigProblem),
}) {}
export class LoopPreviewRequest extends Schema.Class<LoopPreviewRequest>("LoopPreviewRequest")({
  name: LoopFile.fields.name,
  value: Schema.Json,
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
}) {}
export class LoopPreview extends Schema.Class<LoopPreview>("LoopPreview")({
  stream: Stream,
  items: Schema.Array(LoopPreviewItem),
  total: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  prompt: Schema.NullOr(Schema.Struct({ itemKey: ItemKey, text: Schema.String })),
  repositoriesWithoutItems: Schema.Array(RepositoryName),
  failures: Schema.Array(Schema.Struct({ itemKey: ItemKey, message: Schema.String })),
}) {}
