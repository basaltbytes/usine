import { Schema } from "effect";

/** Path to the instance folder, absolute or resolved by the caller. */
export const InstanceDirectory = Schema.NonEmptyString.pipe(Schema.brand("InstanceDirectory"));
export type InstanceDirectory = typeof InstanceDirectory.Type;
