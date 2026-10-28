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

export class ConfigurationWrite extends Schema.Class<ConfigurationWrite>("ConfigurationWrite")({
  expected: ConfigurationRevisionNumber,
  message: Schema.optionalKey(Schema.String),
}) {}

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
export type ConfigurationReplacement = typeof ConfigurationReplacement.Type;

export class ConfigurationEntityView extends Schema.Class<ConfigurationEntityView>(
  "ConfigurationEntityView",
)({
  key: ConfigurationEntityKey,
  value: Schema.Json,
  text: Schema.String,
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

export class ConfigurationRevisionPage extends Schema.Class<ConfigurationRevisionPage>(
  "ConfigurationRevisionPage",
)({
  revisions: Schema.Array(ConfigurationRevisionSummary),
  nextBefore: Schema.NullOr(ConfigurationRevisionNumber),
}) {}

export class ConfigurationNotFound extends Schema.TaggedError<ConfigurationNotFound>(
  "ConfigurationNotFound",
)("ConfigurationNotFound", { message: Schema.String }) {}

export class ConfigurationRevisionView extends Schema.Class<ConfigurationRevisionView>(
  "ConfigurationRevisionView",
)({
  ...ConfigurationRevisionSummary.fields,
  changes: Schema.Array(
    Schema.Struct({
      key: ConfigurationEntityKey,
      before: Schema.NullOr(Schema.Json),
      after: Schema.NullOr(Schema.Json),
      position: Schema.optionalKey(Schema.Int),
    }),
  ),
}) {
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
