import { Schema } from "effect";

/**
 * Loop identity: the loop file's name in the instance repo. Filename is
 * identity — renaming the file retires one loop and creates another
 * (ADR 0001).
 */
export const LoopName = Schema.NonEmptyString.pipe(Schema.brand("LoopName"));
export type LoopName = typeof LoopName.Type;
