import { join } from "node:path";
import type { InstanceDirectory } from "@usine/core/instance";
import { ConfigProvider, Effect, FileSystem, Option, Schema } from "effect";

/** The instance folder's file of `KEY=value` lines that `usine` reads at startup. */
const ENVIRONMENT_FILE = ".env";

/** The instance folder's `.env` exists but couldn't be read. */
class EnvironmentFileError extends Schema.TaggedError<EnvironmentFileError>(
  "@usine/server/EnvironmentFileError",
)("EnvironmentFileError", { path: Schema.String, reason: Schema.String }) {}

/** Returns the child keys of `node`: a record's keys, an array's indices, or none for a value. */
const childKeys = (node: ConfigProvider.Node): ReadonlyArray<string> =>
  node._tag === "Record"
    ? [...node.keys]
    : node._tag === "Array"
      ? Array.from({ length: node.length }, (_, index) => String(index))
      : [];

/**
 * Returns the node that a single variable source holding the variables of both nodes would return:
 * `primary`'s value wins, and the children are those of both nodes.
 */
const mergeNodes = (
  primary: ConfigProvider.Node | undefined,
  fallback: ConfigProvider.Node | undefined,
): ConfigProvider.Node | undefined => {
  if (primary === undefined) return fallback;
  if (fallback === undefined) return primary;
  const value = primary.value ?? fallback.value;
  if (primary._tag === "Record" || fallback._tag === "Record") {
    return ConfigProvider.makeRecord(
      new Set([...childKeys(primary), ...childKeys(fallback)]),
      value,
    );
  }
  if (primary._tag === "Array" || fallback._tag === "Array") {
    return ConfigProvider.makeArray(
      Math.max(childKeys(primary).length, childKeys(fallback).length),
      value,
    );
  }
  return primary;
};

/**
 * Returns `environment` over the variables of the instance folder's `.env`, as dotenv does: a
 * variable that `environment` sets keeps its value, and `.env` sets the others, including a
 * variable whose name prefixes one that `environment` sets (`TOKEN` beside `TOKEN_ID`). Returns
 * `environment` alone if the folder has no `.env`. Doesn't change `process.env`.
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
  const file = ConfigProvider.fromDotEnvContents(contents.value);
  return ConfigProvider.make((configPath) =>
    Effect.zipWith(environment.load(configPath), file.load(configPath), mergeNodes),
  );
});
