import { Schema } from "effect";

/**
 * Value object: stable identity of one piece of software-work state inside a
 * loop. Several content-distinct Events may concern the same Item.
 */
export const ItemKey = Schema.NonEmptyString.pipe(Schema.brand("ItemKey"));
export type ItemKey = typeof ItemKey.Type;

/** Positive repository-local number for an issue-like Item. */
export const Number = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).pipe(
  Schema.brand("ItemNumber"),
);
export type Number = typeof Number.Type;
