import { Effort, ModelId } from "@usine/core/agent/brain";
import { ChildSessionBudget } from "@usine/core/agent/session";
import { OperatorLogin } from "@usine/core/operator";
import { RepositoryName } from "@usine/core/repository";
import {
  GatewayAdminPort,
  GatewayDomain,
  GatewayLlmProvider,
  SshDestination,
  SshIdentityFile,
  SshPort,
  WorkerName,
  WorkerRoot,
} from "@usine/core/worker";
import { Effect, Schema } from "effect";
import { nonBlankString, uniqueRepositoryNames } from "./checks.ts";
import { LaneSource, Lane } from "./board.ts";
import { canonicalLabelName, DeclaredLabel } from "./label.ts";

/** A factory-defined repository grouping that Loops can select by tag. */
export const RegistryTag = nonBlankString("Expected a non-blank registry tag").pipe(
  Schema.brand("RegistryTag"),
);

export type RegistryTag = typeof RegistryTag.Type;

const PositiveInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));

const uniqueNames = Schema.makeFilter<ReadonlyArray<{ readonly name: string }>>(
  (values) => new Set(values.map(({ name }) => name)).size === values.length,
  { message: "Expected unique names" },
);

const laneSourceKey = (source: LaneSource): string =>
  "label" in source ? `label:${canonicalLabelName(source.label)}` : `state:${source.state}`;

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

const MaxConcurrentAttempts = PositiveInt.pipe(Schema.withDecodingDefaultKey(Effect.succeed(1)));

/** The orchestrator's own machine as a Worker, with the number of Attempts it may run at the same time. */
export class LocalWorker extends Schema.Class<LocalWorker>("@usine/config/LocalWorker")({
  name: WorkerName,
  kind: Schema.Literal("local"),
  maxConcurrentAttempts: MaxConcurrentAttempts,
}) {}

/** An exe.dev VM named after the Worker, with the number of Attempts it may run at the same time. */
export class ExeDevWorker extends Schema.Class<ExeDevWorker>("@usine/config/ExeDevWorker")({
  name: WorkerName,
  kind: Schema.Literal("exe.dev"),
  maxConcurrentAttempts: MaxConcurrentAttempts,
}) {}

/** The name of an environment variable of the orchestrator's process. */
const EnvironmentVariableName = Schema.String.check(
  Schema.isPattern(/^[A-Za-z_][A-Za-z0-9_]*$/u, {
    message: "Expected an environment variable name",
  }),
).pipe(Schema.brand("EnvironmentVariableName"));

/**
 * The Gateway in front of an SSH Worker's machine on a private network
 * (ADR 0027). `domain` is the Gateway's private DNS domain. `destination` is
 * what the orchestrator's `ssh` client connects to for the Gateway, usually
 * the Host alias the Worker's `ProxyJump` names; the executor opens its own
 * forward through it to the admin API at `adminPort` on the Gateway's
 * loopback interface, 7070 by default as on the Gateway. The admin token is
 * read from the orchestrator's environment variable `adminTokenEnv` when
 * `usine up` starts or a reload adds the Worker, so it is never in the file.
 * `llmProviders` names the providers whose credential the Gateway holds. A
 * harness whose provider is not listed uses the operator's login on the
 * Worker and reaches the provider through the Gateway's forward proxy; Codex
 * always does.
 */
export class WorkerGateway extends Schema.Class<WorkerGateway>("@usine/config/WorkerGateway")({
  domain: GatewayDomain,
  destination: SshDestination,
  adminPort: GatewayAdminPort.pipe(Schema.withDecodingDefaultKey(Effect.succeed(7070))),
  adminTokenEnv: EnvironmentVariableName,
  llmProviders: Schema.Array(GatewayLlmProvider)
    .check(Schema.isUnique())
    .pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
}) {}

/**
 * A Linux machine the orchestrator connects to over SSH, with the number of
 * Attempts it may run at the same time. The orchestrator's `ssh` client
 * connects to `destination`, on `port` and with `identityFile` when given,
 * and the Worker keeps its state under `<root>/workers/<name>` on the machine.
 * A Worker behind a `gateway` has no GitHub token on its machine: the
 * executor attaches each Attempt's token to the Gateway instead.
 */
export class SshWorker extends Schema.Class<SshWorker>("@usine/config/SshWorker")({
  name: WorkerName,
  kind: Schema.Literal("ssh"),
  maxConcurrentAttempts: MaxConcurrentAttempts,
  destination: SshDestination,
  identityFile: Schema.OptionFromOptionalKey(SshIdentityFile),
  port: Schema.OptionFromOptionalKey(SshPort),
  root: WorkerRoot,
  gateway: Schema.OptionFromOptionalKey(
    WorkerGateway.pipe(
      Schema.encodeKeys({
        adminPort: "admin_port",
        adminTokenEnv: "admin_token_env",
        llmProviders: "llm_providers",
      }),
    ),
  ),
}) {}

/** A named place to execute Attempts; its kind selects the Worker adapter and the settings that adapter needs. */
export const Worker = Schema.Union([LocalWorker, ExeDevWorker, SshWorker]);
export type Worker = typeof Worker.Type;

/** Factory-wide polling, Attempt limits, and defaults for the coordinating parent. */
export class Settings extends Schema.Class<Settings>("@usine/config/Settings")({
  /** Seconds between routine GitHub polling cycles; defaults to 60. */
  pollInterval: PositiveInt.pipe(Schema.withDecodingDefaultKey(Effect.succeed(60))),
  /** Total child sessions allowed over one Attempt's lifetime, including sequential spawns; defaults to four. */
  maxChildren: ChildSessionBudget.pipe(Schema.withDecodingDefaultKey(Effect.succeed(4))),
  /** Wall-clock limit per Attempt in minutes. Absent by default, so the runaway guard sets no time limit. */
  maxAttemptMinutes: Schema.OptionFromOptionalKey(PositiveInt),
  /** Token limit per Attempt, counting the parent and every child. Absent by default, so the runaway guard sets no token limit. */
  maxAttemptTokens: Schema.OptionFromOptionalKey(PositiveInt),
  /** Parent model used when the Agent has no override; when both are absent, Pi selects the model. */
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

const WorkerFromYaml = Schema.Union([
  LocalWorker.pipe(Schema.encodeKeys({ maxConcurrentAttempts: "max_concurrent_attempts" })),
  ExeDevWorker.pipe(Schema.encodeKeys({ maxConcurrentAttempts: "max_concurrent_attempts" })),
  SshWorker.pipe(
    Schema.encodeKeys({
      maxConcurrentAttempts: "max_concurrent_attempts",
      identityFile: "identity_file",
    }),
  ),
]);

const ManagedRepos = Schema.Array(ManagedRepo).check(
  uniqueRepositoryNames((repo: ManagedRepo) => repo.name),
);

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
