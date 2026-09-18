import { Effort, ModelId } from "@usine/core/agent/brain";
import { ChildSessionBudget } from "@usine/core/agent/session";
import { RepositoryName } from "@usine/core/repository";
import { WorkerName, WorkerKind } from "@usine/core/worker";
import { Effect, Schema } from "effect";
import { nonBlankString } from "./checks.ts";
import { LaneSource, Lane } from "./board.ts";
import { canonicalLabelName, DeclaredLabel } from "./label.ts";

/** A factory-defined repository grouping that Loops can select by tag. */
export const RegistryTag = nonBlankString("Expected a non-blank registry tag").pipe(
  Schema.brand("RegistryTag"),
);

export type RegistryTag = typeof RegistryTag.Type;

/** GitHub login identifying the human operator for this factory. */
export const OperatorLogin = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u, {
    message: "Expected a GitHub login",
  }),
).pipe(Schema.brand("OperatorLogin"));

export type OperatorLogin = typeof OperatorLogin.Type;

const PositiveInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));

const uniqueNames = Schema.makeFilter<ReadonlyArray<{ readonly name: string }>>(
  (values) => new Set(values.map(({ name }) => name)).size === values.length,
  { message: "Expected unique names" },
);

const laneSourceKey = (source: LaneSource): string =>
  "label" in source ? `label:${source.label}` : `state:${source.state}`;

const uniqueLaneSources = Schema.makeFilter<ReadonlyArray<Lane>>(
  (lanes) => {
    const keys = lanes.flatMap(({ sources }) => sources.map(laneSourceKey));
    return new Set(keys).size === keys.length;
  },
  { message: "Expected every lane source to be mapped once" },
);

const Lanes = Schema.Array(Lane).check(uniqueNames, uniqueLaneSources);

const uniqueLabelNames = Schema.makeFilter<ReadonlyArray<DeclaredLabel>>(
  (values) => new Set(values.map(({ name }) => canonicalLabelName(name))).size === values.length,
  { message: "Expected unique GitHub label names" },
);

const DeclaredLabels = Schema.Array(DeclaredLabel).check(uniqueLabelNames);

/** A repository the factory manages, with its selector tags and configured Board lanes. */
export class ManagedRepo extends Schema.Class<ManagedRepo>("@usine/config/ManagedRepo")({
  name: RepositoryName,
  tags: Schema.Array(RegistryTag)
    .check(Schema.isUnique())
    .pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
  lanes: Lanes.pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
}) {}

/** A named place to execute Attempts, with the number it may run at the same time. */
export class Worker extends Schema.Class<Worker>("@usine/config/Worker")({
  name: WorkerName,
  kind: WorkerKind,
  maxConcurrentAttempts: PositiveInt.pipe(Schema.withDecodingDefaultKey(Effect.succeed(1))),
}) {}

/** Factory-wide polling, Attempt limits, and defaults for the coordinating parent. */
export class Settings extends Schema.Class<Settings>("@usine/config/Settings")({
  /** Seconds between routine GitHub polling cycles; defaults to 60. */
  pollInterval: PositiveInt.pipe(Schema.withDecodingDefaultKey(Effect.succeed(60))),
  /** Total child sessions allowed over one Attempt's lifetime, including sequential spawns; defaults to four. */
  maxChildren: ChildSessionBudget.pipe(Schema.withDecodingDefaultKey(Effect.succeed(4))),
  /** Wall-clock ceiling per Attempt in minutes. Absent by default: the runaway guard's timer is not armed. */
  maxAttemptMinutes: Schema.OptionFromOptionalKey(PositiveInt),
  /** Consumed-token ceiling per Attempt across the parent and every child. Absent by default: the token guard is not armed. */
  maxAttemptTokens: Schema.OptionFromOptionalKey(PositiveInt),
  /** Parent model used when the Agent has no override; an absent default leaves selection to Pi. */
  parentModel: Schema.OptionFromOptionalKey(ModelId),
  /** Default parent reasoning effort; if neither Agent nor factory supplies one, the child's effort applies. */
  parentEffort: Schema.OptionFromOptionalKey(Effort),
}) {}

/** How GitHub hints reach the factory to request earlier polling; routine polling remains the backstop. */
export const Webhooks = Schema.Union([
  Schema.Struct({ mode: Schema.Literal("off") }),
  Schema.Struct({ mode: Schema.Literal("deliveries") }),
  Schema.Struct({ mode: Schema.Literal("endpoint"), publicUrl: Schema.URLFromString }).pipe(
    Schema.encodeKeys({ publicUrl: "public_url" }),
  ),
]);

export type Webhooks = typeof Webhooks.Type;

// Authored YAML keys are snake_case and domain fields camelCase. The rename
// happens once here and encodes back for edits.
const SettingsFromYaml = Settings.pipe(
  Schema.encodeKeys({
    pollInterval: "poll_interval",
    maxChildren: "max_children",
    maxAttemptMinutes: "max_attempt_minutes",
    maxAttemptTokens: "max_attempt_tokens",
    parentModel: "parent_model",
    parentEffort: "parent_effort",
  }),
);

const WorkerFromYaml = Worker.pipe(
  Schema.encodeKeys({ maxConcurrentAttempts: "max_concurrent_attempts" }),
);

const ManagedRepos = Schema.Array(ManagedRepo).check(uniqueNames);

const Workers = Schema.Array(WorkerFromYaml).check(Schema.isNonEmpty(), uniqueNames);

/** The factory's repository registry, Worker capacity, labels, and operating defaults from `usine.yaml`. */
export class UsineConfig extends Schema.Class<UsineConfig>("@usine/config/UsineConfig")({
  version: Schema.Literal(1),
  labels: DeclaredLabels.pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
  repos: ManagedRepos,
  settings: SettingsFromYaml.pipe(Schema.withDecodingDefaultKey(Effect.succeed({}))),
  workers: Workers.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed([{ name: "local", kind: "local" }])),
  ),
  webhooks: Webhooks.pipe(Schema.withDecodingDefaultKey(Effect.succeed({ mode: "off" }))),
  operator: Schema.OptionFromOptionalKey(OperatorLogin),
}) {}
