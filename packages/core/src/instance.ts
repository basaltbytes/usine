import { Schema } from "effect";

/** The folder with `usine.yaml`, Loop files, and Agent files. */
export const InstanceDirectory = Schema.NonEmptyString.pipe(Schema.brand("InstanceDirectory"));
export type InstanceDirectory = typeof InstanceDirectory.Type;
