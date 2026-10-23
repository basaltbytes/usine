import { ItemKey, ItemNumber } from "@usine/core/item";
import { RepositoryName } from "@usine/core/repository";
import { type DateTime, Effect, Option, Schema } from "effect";

export const ItemProjectionSource = Schema.NonEmptyString.pipe(
  Schema.brand("ItemProjectionSource"),
);
export type ItemProjectionSource = typeof ItemProjectionSource.Type;

export const ItemContentHash = Schema.NonEmptyString.pipe(Schema.brand("ItemContentHash"));
export type ItemContentHash = typeof ItemContentHash.Type;

/**
 * The latest payload a trigger observed for one Item. `goneAt` is the time a poll or re-check
 * found the Item missing on GitHub, or `None` while GitHub has it.
 */
export class ItemProjection extends Schema.Class<ItemProjection>("@usine/engine/ItemProjection")({
  itemKey: ItemKey,
  repository: RepositoryName,
  source: ItemProjectionSource,
  number: ItemNumber,
  contentHash: ItemContentHash,
  payload: Schema.JsonObject,
  goneAt: Schema.OptionFromNullOr(Schema.DateTimeUtcFromString).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
    Schema.withConstructorDefault(Effect.succeed(Option.none<DateTime.Utc>())),
  ),
}) {}
