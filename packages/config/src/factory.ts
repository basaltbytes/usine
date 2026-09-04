import { Effort, ModelId } from "@usine/core/agent/brain";
import { ChildSessionBudget } from "@usine/core/agent/session";
import { RepositoryName } from "@usine/core/repository";
import { WorkerName, WorkerKind } from "@usine/core/worker";
import { Effect, Schema } from "effect";
import { nonBlankString } from "./checks.ts";
import { LaneSource, Lane } from "./board.ts";
import { canonicalLabelName, DeclaredLabel } from "./label.ts";

export const RegistryTag = nonBlankString("Expected a non-blank registry tag").pipe(
  Schema.brand("RegistryTag"),
);

export type RegistryTag = typeof RegistryTag.Type;

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

export class ManagedRepo extends Schema.Class<ManagedRepo>("@usine/config/ManagedRepo")({
  name: RepositoryName,
  tags: Schema.Array(RegistryTag)
    .check(Schema.isUnique())
    .pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
  lanes: Lanes.pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
}) {}

export class Worker extends Schema.Class<Worker>("@usine/config/Worker")({
  name: WorkerName,
  kind: WorkerKind,
  maxConcurrentAttempts: PositiveInt.pipe(Schema.withDecodingDefaultKey(Effect.succeed(1))),
}) {}

export class Settings extends Schema.Class<Settings>("@usine/config/Settings")({
  pollInterval: PositiveInt.pipe(Schema.withDecodingDefaultKey(Effect.succeed(60))),
  /** Total child sessions one Attempt may spawn over its lifetime, not a concurrency limit. */
  maxChildren: ChildSessionBudget.pipe(Schema.withDecodingDefaultKey(Effect.succeed(4))),
  maxAttemptMinutes: PositiveInt.pipe(Schema.withDecodingDefaultKey(Effect.succeed(60))),
  maxAttemptTokens: PositiveInt.pipe(Schema.withDecodingDefaultKey(Effect.succeed(10_000_000))),
  parentModel: Schema.OptionFromOptionalKey(ModelId),
  parentEffort: Schema.OptionFromOptionalKey(Effort),
}) {}

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

/** The parsed `usine.yaml`. */
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
