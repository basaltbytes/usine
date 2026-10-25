import { Effort, ModelId } from "@usine/core/agent/brain";
import { ChildSessionBudget } from "@usine/core/agent/session";
import { OperatorLogin } from "@usine/core/operator";
import { RepositoryName } from "@usine/core/repository";
import {
  BoatSize,
  ContainerCpus,
  ContainerImage,
  ContainerMemoryMib,
  ContainerPids,
  GatewayAdminPort,
  GatewayDomain,
  GatewayLlmProvider,
  HetznerImage,
  HetznerLabels,
  HetznerLocation,
  HetznerResourceName,
  HetznerServerType,
  SshDestination,
  SshIdentityFile,
  SshPort,
  SshUser,
  WorkerName,
  WorkerRoot,
} from "@usine/core/worker";
import { Effect, Option, Schema } from "effect";
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
  { message: "Expected each lane source in only one lane" },
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
 * - `llmProviders`: the providers whose credential the Gateway injects: `anthropic` for Claude
 *   Code, `openai` for Codex. Harnesses for other providers use the operator's login on the
 *   Worker through the forward proxy.
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
 * The container that each Attempt on an SSH Worker runs in, if the machine has Docker.
 *
 * - `image`: the image to run. If `None`, the executor's image for the harness versions of this
 *   release.
 * - `cpus`, `memoryMib`, and `pids`: the limits of each Attempt's container.
 */
export class WorkerContainer extends Schema.Class<WorkerContainer>("@usine/config/WorkerContainer")(
  {
    image: Schema.OptionFromOptionalKey(ContainerImage),
    cpus: ContainerCpus.pipe(Schema.withDecodingDefaultKey(Effect.succeed(2))),
    memoryMib: ContainerMemoryMib.pipe(Schema.withDecodingDefaultKey(Effect.succeed(4096))),
    pids: ContainerPids.pipe(Schema.withDecodingDefaultKey(Effect.succeed(4096))),
  },
) {}

/**
 * The orchestrator environment variables with the LLM provider API keys that each Attempt on a
 * provisioned Worker gets in its environment, read when `usine up` starts or a reload adds the
 * Worker. `anthropic` becomes `ANTHROPIC_API_KEY` for Claude Code, and `openai` becomes
 * `OPENAI_API_KEY` for Codex.
 */
export class ProviderApiKeys extends Schema.Class<ProviderApiKeys>("@usine/config/ProviderApiKeys")(
  {
    anthropic: Schema.OptionFromOptionalKey(EnvironmentVariableName),
    openai: Schema.OptionFromOptionalKey(EnvironmentVariableName),
  },
) {}

const ProviderApiKeysFromYaml = ProviderApiKeys.pipe(
  Schema.withDecodingDefaultKey(Effect.succeed({})),
);

/**
 * Creates one Hetzner Cloud server per Attempt from a snapshot, and deletes it after the
 * Attempt (#550).
 *
 * - `tokenEnv`: the orchestrator environment variable with a Hetzner Cloud API token with read
 *   and write access to the project.
 * - `serverType` and `location`: each server's type and location.
 * - `image`: the snapshot's ID or description, which `infra/hetzner/snapshot.sh` prints.
 * - `network`: the private network to attach each server to. With a Gateway, it's the Gateway's
 *   network and the server gets no public address.
 * - `firewall`: the project's firewall to apply to each server, such as one that admits SSH only
 *   from the orchestrator's address to a server with a public address.
 * - `sshKey`: the name of the SSH key in the project that each server authorizes.
 * - `sshUser`: the user the executor connects as.
 * - `labels`: extra labels for each server.
 * - `apiKeys`: provider API keys for each Attempt, for harnesses whose credential the Gateway
 *   doesn't have.
 */
export class HetznerProvisioner extends Schema.Class<HetznerProvisioner>(
  "@usine/config/HetznerProvisioner",
)({
  provider: Schema.Literal("hetzner"),
  tokenEnv: EnvironmentVariableName,
  serverType: HetznerServerType,
  location: HetznerLocation,
  image: HetznerImage,
  network: Schema.OptionFromOptionalKey(HetznerResourceName),
  firewall: Schema.OptionFromOptionalKey(HetznerResourceName),
  sshKey: HetznerResourceName,
  sshUser: SshUser.pipe(Schema.withDecodingDefaultKey(Effect.succeed("usine"))),
  labels: HetznerLabels.pipe(Schema.withDecodingDefaultKey(Effect.succeed({}))),
  apiKeys: ProviderApiKeysFromYaml,
}) {}

/**
 * Creates one Boat sandbox per Attempt and deletes it after the Attempt (#550). Boat has no
 * network rules, so a Boat Worker has no Gateway, and each Attempt's GitHub token is on its
 * machine (ADR 0026). Boat documents no region choice; its machines are in Germany, Finland, and
 * France.
 *
 * - `tokenEnv`: the orchestrator environment variable with a Boat API key.
 * - `size`: each sandbox's Boat machine type.
 * - `apiKeys`: provider API keys for each Attempt. A harness without one can't authenticate,
 *   because a subscription login needs a Gateway.
 */
export class BoatProvisioner extends Schema.Class<BoatProvisioner>("@usine/config/BoatProvisioner")(
  {
    provider: Schema.Literal("boat"),
    tokenEnv: EnvironmentVariableName,
    size: BoatSize.pipe(Schema.withDecodingDefaultKey(Effect.succeed("default"))),
    apiKeys: ProviderApiKeysFromYaml,
  },
) {}

/** The provider that creates one machine per Attempt for an SSH Worker; `provider` selects it. */
export const WorkerProvisioner = Schema.Union([HetznerProvisioner, BoatProvisioner]);
export type WorkerProvisioner = typeof WorkerProvisioner.Type;

const WorkerProvisionerFromYaml = Schema.Union([
  HetznerProvisioner.pipe(
    Schema.encodeKeys({
      tokenEnv: "token_env",
      serverType: "server_type",
      sshKey: "ssh_key",
      sshUser: "ssh_user",
      apiKeys: "api_keys",
    }),
  ),
  BoatProvisioner.pipe(Schema.encodeKeys({ tokenEnv: "token_env", apiKeys: "api_keys" })),
]);

/**
 * A Linux machine reached with `ssh`, with Worker state under `<root>/workers/<name>`. If
 * `gateway` is set, the machine stores no GitHub token; the executor sends each Attempt's token
 * to the Gateway. A Worker sets either `destination`, for one long-lived machine, or
 * `provisioner`, for one machine per Attempt; `maxConcurrentAttempts` then caps the machines in
 * flight.
 */
export class SshWorker extends Schema.Class<SshWorker>("@usine/config/SshWorker")({
  name: WorkerName,
  kind: Schema.Literal("ssh"),
  maxConcurrentAttempts: MaxConcurrentAttempts,
  destination: Schema.OptionFromOptionalKey(SshDestination),
  provisioner: Schema.OptionFromOptionalKey(WorkerProvisionerFromYaml),
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
  container: WorkerContainer.pipe(
    Schema.encodeKeys({ memoryMib: "memory_mib" }),
    Schema.withDecodingDefaultKey(Effect.succeed({})),
  ),
}) {}

/** Returns the reason an SSH Worker's machine settings conflict, or `undefined` if they don't. */
const sshMachineConflict = (worker: SshWorker): string | undefined => {
  const provisioner = Option.getOrUndefined(worker.provisioner);
  if (provisioner === undefined)
    return Option.isNone(worker.destination)
      ? `SSH worker "${worker.name}" needs a destination or a provisioner`
      : undefined;
  if (Option.isSome(worker.destination))
    return `SSH worker "${worker.name}" sets both destination and provisioner; a provisioned worker creates its machines, so remove destination`;
  if (Option.isSome(worker.port))
    return `SSH worker "${worker.name}" sets port, which a provisioned worker takes from its provider`;
  switch (provisioner.provider) {
    case "hetzner":
      return Option.isSome(worker.gateway) && Option.isNone(provisioner.network)
        ? `SSH worker "${worker.name}" has a gateway, so its provisioner needs the gateway's private network in network`
        : undefined;
    case "boat":
      if (Option.isSome(worker.gateway))
        return `SSH worker "${worker.name}" has a Boat provisioner and a gateway; Boat has no network rules, so no gateway can be its machines' only way out. Remove gateway.`;
      return Option.isNone(worker.identityFile)
        ? `SSH worker "${worker.name}" has a Boat provisioner and needs identity_file, whose .pub file usine adds to each sandbox`
        : undefined;
  }
};

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

const OtlpUrl = Schema.URLFromString.check(
  Schema.makeFilter((url: URL) => url.protocol === "http:" || url.protocol === "https:", {
    message: "Expected an http or https URL",
  }),
  Schema.makeFilter((url: URL) => url.username === "" && url.password === "" && url.search === "", {
    message:
      "Expected a URL without a username, password, or query string; authenticate in a collector next to usine up",
  }),
);

/** Span export over OTLP/HTTP (ADR 0028). */
export class Tracing extends Schema.Class<Tracing>("@usine/config/Tracing")({
  /**
   * The collector's OTLP/HTTP traces endpoint, used as given, such as
   * `http://localhost:4318/v1/traces`. It has no credentials or query string.
   */
  otlpUrl: OtlpUrl,
  /** The `service.name` resource attribute of every exported span. */
  serviceName: nonBlankString("Expected a non-blank service name").pipe(
    Schema.withDecodingDefaultKey(Effect.succeed("usine")),
  ),
}) {}

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
  ).check(Schema.makeFilter((worker: SshWorker) => sshMachineConflict(worker) ?? true)),
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
  tracing: Schema.OptionFromOptionalKey(
    Tracing.pipe(Schema.encodeKeys({ otlpUrl: "otlp_url", serviceName: "service_name" })),
  ),
}) {}
