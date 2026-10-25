import { Schema } from "effect";

/** A non-negative integer in a harness's usage report, such as an input or cached token count. */
export const UsageCount = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
