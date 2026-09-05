import { ItemKey, ItemNumber } from "@usine/core/item";
import { RepositoryName } from "@usine/core/repository";
import { Schema } from "effect";

export const ItemProjectionSource = Schema.NonEmptyString.pipe(
  Schema.brand("ItemProjectionSource"),
);
export type ItemProjectionSource = typeof ItemProjectionSource.Type;

export const ItemContentHash = Schema.NonEmptyString.pipe(Schema.brand("ItemContentHash"));
export type ItemContentHash = typeof ItemContentHash.Type;

/** Latest trigger-observed payload for one Item, independent of its source adapter. */
export class ItemProjection extends Schema.Class<ItemProjection>("@usine/engine/ItemProjection")({
  itemKey: ItemKey,
  repository: RepositoryName,
  source: ItemProjectionSource,
  number: ItemNumber,
  contentHash: ItemContentHash,
  payload: Schema.JsonObject,
}) {}
