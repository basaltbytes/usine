import { Schema } from "effect";

/** Positive repository-local number for an issue-like Item. */
export const ItemNumber = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).pipe(
  Schema.brand("ItemNumber"),
);
export type ItemNumber = typeof ItemNumber.Type;
