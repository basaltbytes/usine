import { Schema } from "effect";

/** The ID of a Run, unchanged across retries of its Step. */
export const RunId = Schema.NonEmptyString.pipe(Schema.brand("RunId"));

export type RunId = typeof RunId.Type;
