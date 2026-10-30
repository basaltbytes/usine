import { Source } from "@usine/expression/expression-engine";
import { Match, Option, Schema, SchemaIssue } from "effect";

/** A file path relative to the instance folder. */
export const InstancePath = Schema.NonEmptyString.pipe(Schema.brand("InstancePath"));

export type InstancePath = typeof InstancePath.Type;

/** The loading or validation stage that produced a configuration diagnostic. */
export const FileStage = Schema.Literals([
  "expression",
  "frontmatter",
  "read",
  "reference",
  "schema",
  "yaml",
]);

export type FileStage = typeof FileStage.Type;

/** A field-level diagnostic with an optional CEL expression and character offset. */
export const ConfigProblem = Schema.Struct({
  /** The field path, using property names and zero-based array indexes. */
  path: Schema.Array(Schema.Union([Schema.String, Schema.Number])),
  /** The validation message for this field. */
  message: Schema.String,
  /** The CEL source associated with the problem, when available. */
  expression: Schema.optionalKey(Source),
  /** Zero-based offset in the expression. */
  position: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
});

/**
 * A failure associated with one file or entity at a validation stage. Permissive folder loading
 * quarantines the affected agent or loop.
 */
export class ConfigFileError extends Schema.TaggedError<ConfigFileError>(
  "@usine/config/ConfigFileError",
)("ConfigFileError", {
  /** The relative file path or entity key associated with the failure. */
  file: InstancePath,
  /** The loading or validation stage that failed. */
  stage: FileStage,
  /** The CEL source that failed, or `None` for failures unrelated to an expression. */
  expression: Schema.OptionFromOptionalKey(Source),
  /** The diagnostic text describing the failure. */
  message: Schema.NonEmptyString,
  /** Field-level diagnostics when available, including paths and optional expression offsets. */
  details: Schema.optionalKey(Schema.Array(ConfigProblem)),
}) {
  /**
   * Converts `error` into a schema-stage diagnostic for `file`, preserving field paths and
   * validation messages.
   */
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
  /** The relative file path or entity key associated with the failure. */
  file: InstancePath,
  /** The loading or validation stage that failed. */
  stage: FileStage,
  /** The diagnostic text describing the failure. */
  message: Schema.NonEmptyString,
}) {}

/** A file validation failure or an instance-wide loading failure. */
export const ConfigError = Schema.Union([ConfigFileError, FactoryConfigError]);

export type ConfigError = typeof ConfigError.Type;
