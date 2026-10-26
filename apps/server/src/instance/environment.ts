import { join } from "node:path";
import type { InstanceDirectory } from "@usine/core/instance";
import { ConfigProvider, Effect, FileSystem, Option, Schema } from "effect";

/** The instance folder's file of `KEY=value` lines that `usine` reads at startup. */
const ENVIRONMENT_FILE = ".env";

/** The instance folder's `.env` exists but couldn't be read. */
class EnvironmentFileError extends Schema.TaggedError<EnvironmentFileError>(
  "@usine/server/EnvironmentFileError",
)("EnvironmentFileError", { path: Schema.String, reason: Schema.String }) {}

/**
 * Returns `environment` over the variables of the instance folder's `.env`, as dotenv does: a
 * variable that `environment` sets keeps its value. Returns `environment` alone if the folder has
 * no `.env`. Doesn't change `process.env`.
 */
export const instanceEnvironment = Effect.fn("Instance.environment")(function* (
  directory: InstanceDirectory,
  environment: ConfigProvider.ConfigProvider,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = join(directory, ENVIRONMENT_FILE);
  const contents = yield* fileSystem.readFileString(path).pipe(
    Effect.map(Option.some),
    Effect.catchIf(
      ({ reason }) => reason._tag === "NotFound",
      () => Effect.succeedNone,
    ),
    Effect.mapError(({ message }) => new EnvironmentFileError({ path, reason: message })),
  );
  yield* Effect.annotateCurrentSpan({ path, found: Option.isSome(contents) });
  if (Option.isNone(contents)) {
    yield* Effect.logDebug("The instance folder has no environment file", { path });
    return environment;
  }
  yield* Effect.logDebug("Read the instance environment file", { path });
  return ConfigProvider.orElse(environment, ConfigProvider.fromDotEnvContents(contents.value));
});
