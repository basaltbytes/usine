import { InstanceId } from "@usine/core/instance";
import { type Brand, Effect, FileSystem, Schema, Crypto } from "effect";
import type { InstanceFiles } from "./record.ts";

/** `.usine/instance-id` couldn't be read or created, or doesn't contain an instance ID. */
export class InstanceIdError extends Schema.TaggedError<
  InstanceIdError,
  Brand.Brand<"@usine/server/instance/id/InstanceIdError">
>("@usine/server/InstanceIdError")("InstanceIdError", {
  operation: Schema.Literals(["read", "create"]),
  path: Schema.String,
  reason: Schema.String,
}) {}

const InstanceIdFromText = Schema.Trim.pipe(Schema.decodeTo(InstanceId));

/**
 * Returns the ID in `.usine/instance-id`, or writes a new one there if the file doesn't exist.
 * Call it while holding the instance lock, so that no other process writes the file.
 */
export const instanceIdOf = Effect.fn("Instance.id")(function* (files: InstanceFiles) {
  const fileSystem = yield* FileSystem.FileSystem;
  const failure =
    (operation: InstanceIdError["operation"]) => (error: { readonly message: string }) =>
      InstanceIdError.make({ operation, path: files.id, reason: error.message });
  if (yield* fileSystem.exists(files.id).pipe(Effect.mapError(failure("read")))) {
    const text = yield* fileSystem.readFileString(files.id).pipe(Effect.mapError(failure("read")));
    const instanceId = yield* Schema.decodeEffect(InstanceIdFromText)(text).pipe(
      Effect.mapError(failure("read")),
    );
    yield* Effect.annotateCurrentSpan({ instanceId });
    yield* Effect.logDebug("Read the instance ID", { instanceId, path: files.id });
    return instanceId;
  }
  const uuid = yield* (yield* Crypto.Crypto).randomUUIDv4().pipe(Effect.orDie);
  const instanceId = InstanceId.make(uuid);
  yield* Effect.annotateCurrentSpan({ instanceId });
  // A rename never leaves a partial file for the next start to refuse.
  const staging = `${files.id}.${instanceId}`;
  yield* fileSystem
    .writeFileString(staging, `${instanceId}\n`)
    .pipe(Effect.andThen(fileSystem.rename(staging, files.id)), Effect.mapError(failure("create")));
  yield* Effect.logInfo("Created the instance ID", { instanceId, path: files.id });
  return instanceId;
});
