import { Schema } from "effect";

/** The ID of an issue or pull request; several Events can have the same Item. */
export const ItemKey = Schema.NonEmptyString.pipe(Schema.brand("ItemKey"));

export type ItemKey = typeof ItemKey.Type;

export const ItemNumber = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).pipe(
  Schema.brand("ItemNumber"),
);
export type ItemNumber = typeof ItemNumber.Type;
