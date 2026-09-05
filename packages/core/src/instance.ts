import { Schema } from "effect";

/** Root folder containing the factory's `usine.yaml`, Loop files, and Agent roster; the caller resolves its location. */
export const InstanceDirectory = Schema.NonEmptyString.pipe(Schema.brand("InstanceDirectory"));
export type InstanceDirectory = typeof InstanceDirectory.Type;
