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
 * The latest payload a trigger observed for one Item, whatever the source
 * adapter. `goneAt` is when a poll or a queued Event's re-check found that
 * GitHub no longer has the Item; the payload is then the last one GitHub
 * returned. None while GitHub has it.
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
