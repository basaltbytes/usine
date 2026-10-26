import { join } from "node:path";
import type { InstanceDirectory } from "@usine/core/instance";
import { ConfigProvider, Effect, FileSystem, Schema } from "effect";

/** `.env` exists in the instance folder, but couldn't be read. */
export class InstanceEnvironmentError extends Schema.TaggedError<InstanceEnvironmentError>(
  "@usine/server/InstanceEnvironmentError",
)("InstanceEnvironmentError", { path: Schema.String, reason: Schema.String }) {}

/**
 * Returns the current `ConfigProvider` with `.env` of the instance folder under it, or the current
 * provider alone if the folder has no `.env`.
 */
const instanceEnvironment = Effect.fn("Instance.environment")(function* (
  directory: InstanceDirectory,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const current = yield* ConfigProvider.ConfigProvider;
  const path = join(directory, ".env");
  yield* Effect.annotateCurrentSpan({ path });
  const failure = (error: { readonly message: string }) =>
    new InstanceEnvironmentError({ path, reason: error.message });
  if (!(yield* fileSystem.exists(path).pipe(Effect.mapError(failure)))) {
    yield* Effect.logDebug("The instance folder has no .env", { path });
    return current;
  }
  const contents = yield* fileSystem.readFileString(path).pipe(Effect.mapError(failure));
  yield* Effect.logDebug("Read .env under the process environment", { path });
  return current.pipe(ConfigProvider.orElse(ConfigProvider.fromDotEnvContents(contents)));
});

/**
 * Runs `effect` with the variables of `.env` in the instance folder under the process environment:
 * `.env` sets a variable only if the process environment doesn't set it, or sets it empty. The
 * values stay out of `process.env`, so child processes don't inherit them.
 */
export const withInstanceEnvironment =
  (directory: InstanceDirectory) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.flatMap(instanceEnvironment(directory), (environment) =>
      Effect.provideService(effect, ConfigProvider.ConfigProvider, environment),
    );
