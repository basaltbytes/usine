import { Schema } from "effect";

export const FileStage = Schema.Literals([
  "expression",
  "frontmatter",
  "read",
  "reference",
  "schema",
  "yaml",
]);
export type FileStage = typeof FileStage.Type;

/** One precise, file-owned config failure suitable for quarantine UI. */
export class ConfigFileError extends Schema.TaggedError<ConfigFileError>(
  "@usine/config/ConfigFileError",
)("ConfigFileError", {
  file: Schema.NonEmptyString,
  stage: FileStage,
  message: Schema.NonEmptyString,
}) {}

/** A factory-level failure: the registry/settings boundary could not be loaded. */
export class FactoryConfigError extends Schema.TaggedError<FactoryConfigError>(
  "@usine/config/FactoryConfigError",
)("FactoryConfigError", {
  file: Schema.NonEmptyString,
  stage: FileStage,
  message: Schema.NonEmptyString,
}) {}

/** Every failure mode this package's parsers and loaders can produce. */
export const ConfigError = Schema.Union([ConfigFileError, FactoryConfigError]);
export type ConfigError = typeof ConfigError.Type;
