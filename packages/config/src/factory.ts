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

/** A repository tag that Loop selectors match. */
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

export class ManagedRepo extends Schema.Class<ManagedRepo>("@usine/config/ManagedRepo")({
  name: RepositoryName,
  tags: Schema.Array(RegistryTag)
    .check(Schema.isUnique())
    .pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
  lanes: Lanes.pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
}) {}

const MaxConcurrentAttempts = PositiveInt.pipe(Schema.withDecodingDefaultKey(Effect.succeed(1)));

/** A Worker that runs Attempts on the orchestrator's machine. */
export class LocalWorker extends Schema.Class<LocalWorker>("@usine/config/LocalWorker")({
  name: WorkerName,
  kind: Schema.Literal("local"),
  maxConcurrentAttempts: MaxConcurrentAttempts,
}) {}

/** A Worker on the exe.dev VM with the same name. */
export class ExeDevWorker extends Schema.Class<ExeDevWorker>("@usine/config/ExeDevWorker")({
  name: WorkerName,
  kind: Schema.Literal("exe.dev"),
  maxConcurrentAttempts: MaxConcurrentAttempts,
}) {}

const EnvironmentVariableName = Schema.String.check(
  Schema.isPattern(/^[A-Za-z_][A-Za-z0-9_]*$/u, {
    message: "Expected an environment variable name",
  }),
).pipe(Schema.brand("EnvironmentVariableName"));

/**
 * The Gateway in front of an SSH Worker's machine on a private network (ADR 0027).
 *
 * - `domain`: the Gateway's private DNS domain.
 * - `destination`: the Gateway's `ssh` destination, usually the Host alias in the Worker's
 *   `ProxyJump`. The executor forwards through it to the admin API at `adminPort` on the
 *   Gateway's loopback interface.
 * - `adminTokenEnv`: the orchestrator environment variable with the admin token, read when
 *   `usine up` starts or a reload adds the Worker.
 * - `llmProviders`: the providers whose credential the Gateway injects. Harnesses for other
 *   providers, and Codex, use the operator's login on the Worker through the forward proxy.
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
 * A Linux machine reached with `ssh`, with Worker state under `<root>/workers/<name>`. If
 * `gateway` is set, the machine stores no GitHub token; the executor sends each Attempt's token
 * to the Gateway.
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

/** A configured Worker; `kind` selects the adapter. */
export const Worker = Schema.Union([LocalWorker, ExeDevWorker, SshWorker]);
export type Worker = typeof Worker.Type;

export class Settings extends Schema.Class<Settings>("@usine/config/Settings")({
  /** The interval between GitHub polling cycles, in seconds. */
  pollInterval: PositiveInt.pipe(Schema.withDecodingDefaultKey(Effect.succeed(60))),
  /** The maximum number of child sessions per Attempt, counting sequential spawns. */
  maxChildren: ChildSessionBudget.pipe(Schema.withDecodingDefaultKey(Effect.succeed(4))),
  /** The wall-clock limit per Attempt, in minutes, or `None` for no limit. */
  maxAttemptMinutes: Schema.OptionFromOptionalKey(PositiveInt),
  /** The token limit per Attempt, counting the parent and every child, or `None` for no limit. */
  maxAttemptTokens: Schema.OptionFromOptionalKey(PositiveInt),
  /** The parent model for Agents that set none, or `None` to let Pi select it. */
  parentModel: Schema.OptionFromOptionalKey(ModelId),
  /** The parent reasoning effort for Agents that set none, or `None` to use the child's effort. */
  parentEffort: Schema.OptionFromOptionalKey(Effort),
}) {}

/** The source of GitHub webhook events that trigger an early poll; polling continues in every mode. */
export const Webhooks = Schema.Union([
  Schema.Struct({ mode: Schema.Literal("off") }),
  Schema.Struct({ mode: Schema.Literal("deliveries") }),
  Schema.Struct({ mode: Schema.Literal("endpoint"), publicUrl: Schema.URLFromString }).pipe(
    Schema.encodeKeys({ publicUrl: "public_url" }),
  ),
]);

export type Webhooks = typeof Webhooks.Type;

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

/** The decoded `usine.yaml`. */
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
