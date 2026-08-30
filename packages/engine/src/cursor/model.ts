import { Schema } from "effect";

/** Stable identity of one efficiency-only runtime cursor. */
export const CursorKey = Schema.NonEmptyString.pipe(Schema.brand("CursorKey"));
export type CursorKey = typeof CursorKey.Type;

/** Opaque cursor value; the module that owns the key also owns its schema. */
export class CursorEntry extends Schema.Class<CursorEntry>("@usine/engine/CursorEntry")({
  key: CursorKey,
  value: Schema.Json,
}) {}
