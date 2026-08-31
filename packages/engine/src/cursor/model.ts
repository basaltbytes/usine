import { Schema } from "effect";

/** Stable identity of one efficiency-only runtime cursor. */
export const CursorKey = Schema.NonEmptyString.pipe(Schema.brand("CursorKey"));
export type CursorKey = typeof CursorKey.Type;
