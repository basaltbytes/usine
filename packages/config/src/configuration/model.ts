import { OperatorLogin } from "@usine/core/operator";
import { Option, Schema } from "effect";
import { ConfigFileError } from "../file.ts";
import { LoadedInstance } from "../instance/instance.ts";

/** A nonnegative revision number; zero identifies an uninitialized configuration. */
export const ConfigurationRevisionNumber = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).pipe(
  Schema.brand("ConfigurationRevisionNumber"),
);
export type ConfigurationRevisionNumber = typeof ConfigurationRevisionNumber.Type;

/** The configuration entity categories that can change in a revision. */
export const ConfigurationEntityKind = Schema.Literals([
  "settings",
  "worker",
  "repository",
  "project",
  "label",
  "loop",
  "agent",
]);
export type ConfigurationEntityKind = typeof ConfigurationEntityKind.Type;

/**
 * An entity identifier within its kind; settings use `instance` and version 2 loops use
 * `project/loop`.
 */
export const ConfigurationEntityId = Schema.NonEmptyString.pipe(
  Schema.brand("ConfigurationEntityId"),
);
export type ConfigurationEntityId = typeof ConfigurationEntityId.Type;

/** The kind and identifier that uniquely identify one configuration entity. */
export class ConfigurationEntityKey extends Schema.Class<ConfigurationEntityKey>(
  "@usine/config/ConfigurationEntityKey",
)({
  /** The entity category used to interpret its value. */
  kind: ConfigurationEntityKind,
  /** The identifier within the category; settings use `instance`. */
  identifier: ConfigurationEntityId,
}) {
  /** Returns `kind:identifier` for entity lookup and comparison. */
  get key(): string {
    return `${this.kind}:${this.identifier}`;
  }
}

/**
 * Values use the JSON codec of their entity schema. Settings use the singleton identifier
 * `instance`.
 */
export class ConfigurationEntity extends Schema.Class<ConfigurationEntity>(
  "@usine/config/ConfigurationEntity",
)({
  /** The kind and identifier of this entity. */
  key: ConfigurationEntityKey,
  /** The entity's encoded JSON value, including parser defaults. */
  value: Schema.Json,
}) {}

/** An entity addition, edit, removal, or worker reorder in a configuration revision. */
export class ConfigurationChange extends Schema.Class<ConfigurationChange>(
  "@usine/config/ConfigurationChange",
)({
  /** The entity affected by the change. */
  key: ConfigurationEntityKey,
  /** The expected previous value, or `None` when adding an entity. */
  before: Schema.Option(Schema.Json),
  /** The replacement value, or `None` when removing an entity. */
  after: Schema.Option(Schema.Json),
  /** Zero-based position among workers; omitted for other kinds and value-only edits. */
  position: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
}) {}

/** A configuration snapshot at a revision. Only revision zero has no loaded instance. */
export class Configuration extends Schema.Class<Configuration>("@usine/config/Configuration")(
  Schema.Struct({
    /** The current revision number, or zero before initialization. */
    number: ConfigurationRevisionNumber,
    /** The validated snapshot, or `None` only before initialization. */
    instance: Schema.Option(LoadedInstance),
  }).check(
    Schema.makeFilter(({ number, instance }) => (number === 0) === Option.isNone(instance), {
      message: "Only an uninitialized configuration has revision zero",
    }),
  ),
) {
  /**
   * Returns the configured operator login, or `None` before initialization or when no operator is
   * configured.
   */
  get actor(): Option.Option<OperatorLogin> {
    return Option.flatMap(this.instance, ({ config }) => config.operator);
  }

  /** The uninitialized snapshot at revision zero, before the first successful commit. */
  static readonly empty = new Configuration({
    number: ConfigurationRevisionNumber.make(0),
    instance: Option.none(),
  });
}

/** A committed configuration change with its attribution and UTC time (ADR 0031). */
export class ConfigurationRevision extends Schema.Class<ConfigurationRevision>(
  "@usine/config/ConfigurationRevision",
)({
  /** The positive, increasing revision number assigned by commit. */
  number: ConfigurationRevisionNumber.check(Schema.isGreaterThan(0)),
  /** The operator login attributed to this change, or `None` when unavailable. */
  actor: Schema.Option(OperatorLogin),
  /** The UTC time of the commit, supplied by the caller or store clock. */
  time: Schema.DateTimeUtc,
  /** The optional operator description of the change. */
  message: Schema.Option(Schema.String),
  /** The normalized entity changes, including worker positions where ordering changed. */
  changes: Schema.Array(ConfigurationChange),
}) {}

/** A refused commit whose expected revision differs from the current revision. */
export class StaleRevision extends Schema.TaggedError<StaleRevision>("@usine/config/StaleRevision")(
  "StaleRevision",
  {
    /** The revision number the caller used as the base for its changes. */
    expected: ConfigurationRevisionNumber,
    /** The current revision number that caused the commit to be refused. */
    actual: ConfigurationRevisionNumber,
  },
) {}

/** Configuration validation failures collected before a candidate can be committed. */
export class ConfigurationInvalid extends Schema.TaggedError<ConfigurationInvalid>(
  "@usine/config/ConfigurationInvalid",
)("ConfigurationInvalid", {
  /** The nonempty list of file or entity diagnostics collected during validation. */
  problems: Schema.NonEmptyArray(ConfigFileError),
}) {}

/** A storage or export failure with the attempted operation and original cause. */
export class ConfigurationStoreError extends Schema.TaggedError<ConfigurationStoreError>(
  "@usine/config/ConfigurationStoreError",
)("ConfigurationStoreError", {
  /** The storage or export operation that failed. */
  operation: Schema.String,
  /** The original failure for diagnosis. */
  cause: Schema.Defect(),
}) {}

/** A refused revert because later revisions changed entities in the target revision. */
export class ConfigurationRevertBlocked extends Schema.TaggedError<ConfigurationRevertBlocked>(
  "@usine/config/ConfigurationRevertBlocked",
)("ConfigurationRevertBlocked", {
  /** The entities in the target revision that later revisions also changed. */
  entities: Schema.NonEmptyArray(ConfigurationEntityKey),
}) {}
