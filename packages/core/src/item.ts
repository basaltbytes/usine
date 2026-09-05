import { Schema } from "effect";

/**
 * Stable identity of one piece of software-work state inside a loop. Several
 * content-distinct Events may concern the same Item.
 */
export const ItemKey = Schema.NonEmptyString.pipe(Schema.brand("ItemKey"));

export type ItemKey = typeof ItemKey.Type;

/** Positive repository-local number for an issue-like Item. */
export const ItemNumber = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).pipe(
  Schema.brand("ItemNumber"),
);
export type ItemNumber = typeof ItemNumber.Type;
