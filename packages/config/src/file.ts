import { Source } from "@usine/expression/expression-engine";
import { Match, Option, Schema, SchemaIssue } from "effect";

/** A file path relative to the instance folder. */
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

/** An error in one file at one parse stage; only that file is quarantined. */
export class ConfigFileError extends Schema.TaggedError<ConfigFileError>(
  "@usine/config/ConfigFileError",
)("ConfigFileError", {
  file: InstancePath,
  stage: FileStage,
  expression: Schema.OptionFromOptionalKey(Source),
  message: Schema.NonEmptyString,
  details: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        path: Schema.Array(Schema.Union([Schema.String, Schema.Number])),
        message: Schema.String,
      }),
    ),
  ),
}) {
  static fromSchema(file: InstancePath, error: Schema.SchemaError): ConfigFileError {
    const details = SchemaIssue.makeFormatterStandardSchemaV1()(error.issue).issues.map(
      ({ path, message }) => ({
        path: (path ?? []).map((segment) =>
          Match.value(segment).pipe(
            Match.when(Match.string, (key) => key),
            Match.when(Match.number, (key) => key),
            Match.when(Match.symbol, String),
            Match.orElse(({ key }) => String(key)),
          ),
        ),
        message,
      }),
    );
    return new ConfigFileError({
      file,
      stage: "schema",
      expression: Option.none(),
      message: SchemaIssue.makeFormatterDefault()(error.issue),
      details,
    });
  }
}

/** An error loading the registry or settings, which fails the whole instance load. */
export class FactoryConfigError extends Schema.TaggedError<FactoryConfigError>(
  "@usine/config/FactoryConfigError",
)("FactoryConfigError", {
  file: InstancePath,
  stage: FileStage,
  message: Schema.NonEmptyString,
}) {}

export const ConfigError = Schema.Union([ConfigFileError, FactoryConfigError]);

export type ConfigError = typeof ConfigError.Type;
