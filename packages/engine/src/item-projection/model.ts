import { ItemKey, ItemNumber } from "@usine/core/item";
import { RepositoryName } from "@usine/core/repository";
import { type DateTime, Effect, Option, Schema } from "effect";

/**
 * The stream that observed an item, such as `issue` or `pr`; decoding accepts any nonempty stream
 * name.
 */
export const ItemProjectionSource = Schema.NonEmptyString.pipe(
  Schema.brand("ItemProjectionSource"),
);
export type ItemProjectionSource = typeof ItemProjectionSource.Type;

/**
 * A nonempty hash of the observed payload slice, used to detect changes without comparing stored
 * JSON (ADR 0007).
 */
export const ItemContentHash = Schema.NonEmptyString.pipe(Schema.brand("ItemContentHash"));
export type ItemContentHash = typeof ItemContentHash.Type;

/**
 * The latest payload a trigger observed for one Item. `goneAt` is the time a poll or re-check
 * found the Item missing on GitHub, or `None` while GitHub has it.
 */
export class ItemProjection extends Schema.Class<ItemProjection>("@usine/engine/ItemProjection")({
  /** The stable item identity used to replace its previous snapshot. */
  itemKey: ItemKey,
  /** The managed repo in which the item was observed. */
  repository: RepositoryName,
  /** The trigger stream that observed the item. */
  source: ItemProjectionSource,
  /** The issue or pull request number within the repository. */
  number: ItemNumber,
  /** The hash of the observed payload used to skip unchanged writes. */
  contentHash: ItemContentHash,
  /**
   * The latest observed payload slice, including the fields used by triggers and operator views.
   */
  payload: Schema.JsonObject,
  /**
   * The UTC time a poll or recheck found the item missing, or `None` while present; defaults to
   * `None`.
   */
  goneAt: Schema.OptionFromNullOr(Schema.DateTimeUtcFromString).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
    Schema.withConstructorDefault(Effect.succeed(Option.none<DateTime.Utc>())),
  ),
}) {}
