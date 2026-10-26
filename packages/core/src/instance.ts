import { Schema } from "effect";

/** The folder with `usine.yaml`, Loop files, and Agent files. */
export const InstanceDirectory = Schema.NonEmptyString.pipe(Schema.brand("InstanceDirectory"));
export type InstanceDirectory = typeof InstanceDirectory.Type;

/**
 * The UUID of one instance folder, which tells apart instances that share a GitHub App. It
 * stays the same across restarts of the instance.
 */
export const InstanceId = Schema.String.check(Schema.isUUID()).pipe(Schema.brand("InstanceId"));
export type InstanceId = typeof InstanceId.Type;
