import { Schema } from "effect";

/**
 * Absolute or caller-resolved path to the instance folder (ADR 0001). Shared
 * by every package that anchors itself to the instance repo — the engine's
 * database adapters and the config loader.
 */
export const InstanceDirectory = Schema.NonEmptyString.pipe(Schema.brand("InstanceDirectory"));
export type InstanceDirectory = typeof InstanceDirectory.Type;
