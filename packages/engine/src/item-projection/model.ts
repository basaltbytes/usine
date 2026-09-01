import { Item, Repository } from "@usine/core";
import { Schema } from "effect";

export const ItemProjectionSource = Schema.NonEmptyString.pipe(
  Schema.brand("ItemProjectionSource"),
);
export type ItemProjectionSource = typeof ItemProjectionSource.Type;

export const ItemNumber = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).pipe(
  Schema.brand("ItemNumber"),
);
export type ItemNumber = typeof ItemNumber.Type;

export const ItemContentHash = Schema.NonEmptyString.pipe(Schema.brand("ItemContentHash"));
export type ItemContentHash = typeof ItemContentHash.Type;

/** Latest trigger-observed payload for one Item, independent of its source adapter. */
export class ItemProjection extends Schema.Class<ItemProjection>("@usine/engine/ItemProjection")({
  itemKey: Item.ItemKey,
  repository: Repository.Name,
  source: ItemProjectionSource,
  number: ItemNumber,
  contentHash: ItemContentHash,
  payload: Schema.JsonObject,
}) {}
