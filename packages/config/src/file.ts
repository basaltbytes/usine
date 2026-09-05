import { Source } from "@usine/expression/expression-engine";
import { Schema } from "effect";

/** Path of one authored file, relative to the instance folder. */
export const InstancePath = Schema.NonEmptyString.pipe(Schema.brand("InstancePath"));

export type InstancePath = typeof InstancePath.Type;

export const FileStage = Schema.Literals([
  "expression",
  "frontmatter",
  "read",
  "reference",
  "schema",
  "yaml",
]);

export type FileStage = typeof FileStage.Type;

/** A failure pinned to one authored file and one parse stage, so the UI can quarantine that file alone. */
export class ConfigFileError extends Schema.TaggedError<ConfigFileError>(
  "@usine/config/ConfigFileError",
)("ConfigFileError", {
  file: InstancePath,
  stage: FileStage,
  expression: Schema.OptionFromOptionalKey(Source),
  message: Schema.NonEmptyString,
}) {}

/** The registry or settings could not be loaded, which blocks the whole instance. */
export class FactoryConfigError extends Schema.TaggedError<FactoryConfigError>(
  "@usine/config/FactoryConfigError",
)("FactoryConfigError", {
  file: InstancePath,
  stage: FileStage,
  message: Schema.NonEmptyString,
}) {}

export const ConfigError = Schema.Union([ConfigFileError, FactoryConfigError]);

export type ConfigError = typeof ConfigError.Type;
