import { Schema } from "effect";

/** Identity of the issue or pull request a loop acts on. Many content-distinct Events can concern one Item. */
export const ItemKey = Schema.NonEmptyString.pipe(Schema.brand("ItemKey"));

export type ItemKey = typeof ItemKey.Type;

/** The issue or pull request number within its repository. */
export const ItemNumber = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).pipe(
  Schema.brand("ItemNumber"),
);
export type ItemNumber = typeof ItemNumber.Type;
