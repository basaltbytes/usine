import { OperatorLogin } from "@usine/core/operator";
import { Option, Schema } from "effect";
import { ConfigFileError } from "../file.ts";
import { LoadedInstance } from "../instance/instance.ts";

export const ConfigurationRevisionNumber = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).pipe(
  Schema.brand("ConfigurationRevisionNumber"),
);
export type ConfigurationRevisionNumber = typeof ConfigurationRevisionNumber.Type;

export const ConfigurationEntityKind = Schema.Literals([
  "settings",
  "worker",
  "repository",
  "label",
  "loop",
  "agent",
]);
export type ConfigurationEntityKind = typeof ConfigurationEntityKind.Type;

export const ConfigurationEntityId = Schema.NonEmptyString.pipe(
  Schema.brand("ConfigurationEntityId"),
);
export type ConfigurationEntityId = typeof ConfigurationEntityId.Type;

export class ConfigurationEntityKey extends Schema.Class<ConfigurationEntityKey>(
  "@usine/config/ConfigurationEntityKey",
)({ kind: ConfigurationEntityKind, identifier: ConfigurationEntityId }) {
  get key(): string {
    return `${this.kind}:${this.identifier}`;
  }
}

/** Values use the JSON codec of their entity schema. Settings use the singleton identifier `instance`. */
export class ConfigurationEntity extends Schema.Class<ConfigurationEntity>(
  "@usine/config/ConfigurationEntity",
)({ key: ConfigurationEntityKey, value: Schema.Json }) {}

export class ConfigurationChange extends Schema.Class<ConfigurationChange>(
  "@usine/config/ConfigurationChange",
)({
  key: ConfigurationEntityKey,
  before: Schema.Option(Schema.Json),
  after: Schema.Option(Schema.Json),
  /** Zero-based position among workers; omitted for other kinds and value-only edits. */
  position: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
}) {}

export class Configuration extends Schema.Class<Configuration>("@usine/config/Configuration")(
  Schema.Struct({
    number: ConfigurationRevisionNumber,
    instance: Schema.Option(LoadedInstance),
  }).check(
    Schema.makeFilter(({ number, instance }) => (number === 0) === Option.isNone(instance), {
      message: "Only an uninitialized configuration has revision zero",
    }),
  ),
) {
  static readonly empty = new Configuration({
    number: ConfigurationRevisionNumber.make(0),
    instance: Option.none(),
  });
}

export class ConfigurationRevision extends Schema.Class<ConfigurationRevision>(
  "@usine/config/ConfigurationRevision",
)({
  number: ConfigurationRevisionNumber.check(Schema.isGreaterThan(0)),
  actor: Schema.Option(OperatorLogin),
  time: Schema.DateTimeUtc,
  message: Schema.Option(Schema.String),
  changes: Schema.Array(ConfigurationChange),
}) {}

export class StaleRevision extends Schema.TaggedError<StaleRevision>("@usine/config/StaleRevision")(
  "StaleRevision",
  { expected: ConfigurationRevisionNumber, actual: ConfigurationRevisionNumber },
) {}

export class ConfigurationInvalid extends Schema.TaggedError<ConfigurationInvalid>(
  "@usine/config/ConfigurationInvalid",
)("ConfigurationInvalid", { problems: Schema.NonEmptyArray(ConfigFileError) }) {}

export class ConfigurationStoreError extends Schema.TaggedError<ConfigurationStoreError>(
  "@usine/config/ConfigurationStoreError",
)("ConfigurationStoreError", { operation: Schema.String, cause: Schema.Defect() }) {}
