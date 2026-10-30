import {
  ConfigurationEntityId,
  ConfigurationEntityKey,
  ConfigurationRevisionNumber,
  type ConfigurationRevision,
} from "@usine/config/configuration";
import { OperatorLogin } from "@usine/core/operator";
import { Option, Schema } from "effect";

export class ConfigurationEntityRequest extends Schema.Class<ConfigurationEntityRequest>(
  "ConfigurationEntityRequest",
)({ kind: Schema.String, identifier: ConfigurationEntityId }) {}

export class ConfigurationRevisionQuery extends Schema.Class<ConfigurationRevisionQuery>(
  "ConfigurationRevisionQuery",
)({
  kind: Schema.optionalKey(Schema.String),
  identifier: Schema.optionalKey(ConfigurationEntityId),
  before: Schema.optionalKey(ConfigurationRevisionNumber),
  limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 })),
}) {}

/** Concurrency and attribution metadata for a configuration edit. */
export class ConfigurationWrite extends Schema.Class<ConfigurationWrite>("ConfigurationWrite")({
  /** The configuration revision the caller edited; a newer stored revision rejects the write. */
  expected: ConfigurationRevisionNumber,
  /** An optional operator explanation stored with the revision. */
  message: Schema.optionalKey(Schema.String),
}) {}

/**
 * A replacement entity in form JSON or editable text, with the expected revision and optional
 * worker position.
 */
export const ConfigurationReplacement = Schema.Union([
  Schema.Struct({
    ...ConfigurationWrite.fields,
    value: Schema.Json,
    text: Schema.optionalKey(Schema.Never),
    position: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  }),
  Schema.Struct({
    ...ConfigurationWrite.fields,
    text: Schema.String,
    value: Schema.optionalKey(Schema.Never),
    position: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  }),
]);
/**
 * A replacement entity in form JSON or editable text, with the expected revision and optional
 * worker position.
 */
export type ConfigurationReplacement = typeof ConfigurationReplacement.Type;

/** One configuration entity in both form JSON and editable text, at a stored revision. */
export class ConfigurationEntityView extends Schema.Class<ConfigurationEntityView>(
  "ConfigurationEntityView",
)({
  /** The configuration kind and entity identity. */
  key: ConfigurationEntityKey,
  /** The entity as form JSON with parser defaults applied. */
  value: Schema.Json,
  /** The entity serialized as editable YAML or Markdown. */
  text: Schema.String,
  /** The stored configuration revision used for this read. */
  number: ConfigurationRevisionNumber,
}) {}

export class ConfigurationRevisionSummary extends Schema.Class<ConfigurationRevisionSummary>(
  "ConfigurationRevisionSummary",
)({
  number: ConfigurationRevisionNumber,
  actor: Schema.NullOr(OperatorLogin),
  time: Schema.DateTimeUtc,
  message: Schema.NullOr(Schema.String),
  entities: Schema.Array(ConfigurationEntityKey),
}) {}

/** A newest-first page of configuration revisions with a cursor for older revisions. */
export class ConfigurationRevisionPage extends Schema.Class<ConfigurationRevisionPage>(
  "ConfigurationRevisionPage",
)({
  /** The matching revisions, newest first. */
  revisions: Schema.Array(ConfigurationRevisionSummary),
  /** The exclusive revision cursor for older results, or null at the end. */
  nextBefore: Schema.NullOr(ConfigurationRevisionNumber),
}) {}

export class ConfigurationNotFound extends Schema.TaggedError<ConfigurationNotFound>(
  "ConfigurationNotFound",
)("ConfigurationNotFound", { message: Schema.String }) {}

/**
 * A configuration revision with JSON-compatible changes for operator clients.
 *
 * @property number - The stored revision number.
 * @property actor - The operator login attributed to the revision, or null when unset.
 * @property time - The UTC revision commit time.
 * @property message - The operator explanation, or null without one.
 * @property entities - The entity keys affected by this revision.
 */
export class ConfigurationRevisionView extends Schema.Class<ConfigurationRevisionView>(
  "ConfigurationRevisionView",
)({
  ...ConfigurationRevisionSummary.fields,
  /** The before and after JSON for each changed entity; null denotes creation or removal. */
  changes: Schema.Array(
    Schema.Struct({
      key: ConfigurationEntityKey,
      before: Schema.NullOr(Schema.Json),
      after: Schema.NullOr(Schema.Json),
      position: Schema.optionalKey(Schema.Int),
    }),
  ),
}) {
  /**
   * Converts `revision` to an operator response, replacing absent optional values with null and
   * listing affected entities.
   */
  static fromRevision(revision: ConfigurationRevision): ConfigurationRevisionView {
    return new ConfigurationRevisionView({
      ...revision,
      actor: Option.getOrNull(revision.actor),
      message: Option.getOrNull(revision.message),
      entities: revision.changes.map(({ key }) => key),
      changes: revision.changes.map((change) => ({
        ...change,
        before: Option.getOrNull(change.before),
        after: Option.getOrNull(change.after),
      })),
    });
  }
}
