import { Schema } from "effect";

/** The ID of an Attempt; each retry gets a new ID under the same Run and Step. */
export const AttemptId = Schema.NonEmptyString.pipe(Schema.brand("AttemptId"));

export type AttemptId = typeof AttemptId.Type;
