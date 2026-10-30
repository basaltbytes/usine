import { UpgradeChannel, UpgradeMode } from "@usine/core/upgrade";
import { Effort, ModelId } from "@usine/core/agent/brain";
import { ChildSessionBudget } from "@usine/core/agent/session";
import { OperatorLogin } from "@usine/core/operator";
import { canonicalRepositoryName, RepositoryName } from "@usine/core/repository";
import {
  ProvisionerTimings,
  BoatSize,
  BoatSnapshotName,
  TailnetAddress,
  CloudflareImageName,
  CloudflareInstanceType,
  CloudflareLlmProvider,
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
import { Lanes, Project } from "./project/project.ts";
import { canonicalLabelName, DeclaredLabel } from "./label.ts";

/** A repository tag that loop selectors match. */
export const RegistryTag = nonBlankString("Expected a non-blank registry tag").pipe(
  Schema.brand("RegistryTag"),
);

export type RegistryTag = typeof RegistryTag.Type;

const PositiveInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));

const uniqueNames = Schema.makeFilter<ReadonlyArray<{ readonly name: string }>>(
  (values) => new Set(values.map(({ name }) => name)).size === values.length,
  { message: "Expected unique names" },
);

const uniqueLabelNames = Schema.makeFilter<ReadonlyArray<DeclaredLabel>>(
  (values) => new Set(values.map(({ name }) => canonicalLabelName(name))).size === values.length,
  { message: "Expected unique GitHub label names" },
);

const DeclaredLabels = Schema.Array(DeclaredLabel).check(uniqueLabelNames);

/** A registry entry with selector tags and legacy repository lanes (ADR 0031). */
export class ManagedRepo extends Schema.Class<ManagedRepo>("@usine/config/ManagedRepo")({
  /** The registered GitHub repository in `owner/repo` form. */
  name: RepositoryName,
  /** Unique selector tags; decoding defaults to an empty list. */
  tags: Schema.Array(RegistryTag)
    .check(Schema.isUnique())
    .pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
  /**
   * Repository lanes for version 1 and board views; version 2 persistence requires an empty list
   * (ADR 0031).
   */
  lanes: Lanes.pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
}) {}

const MaxConcurrentAttempts = PositiveInt.pipe(Schema.withDecodingDefaultKey(Effect.succeed(1)));

/** A worker that runs attempts on the orchestrator's machine. */
export class LocalWorker extends Schema.Class<LocalWorker>("@usine/config/LocalWorker")({
  /** The worker identifier, unique within the instance. */
  name: WorkerName,
  /** The discriminator that selects the local executor. */
  kind: Schema.Literal("local"),
  /** The positive number of attempts this worker can run concurrently; decoding defaults to 1. */
  maxConcurrentAttempts: MaxConcurrentAttempts,
}) {}

/** A worker on the exe.dev VM with the same name. */
export class ExeDevWorker extends Schema.Class<ExeDevWorker>("@usine/config/ExeDevWorker")({
  /** The worker identifier, unique within the instance. */
  name: WorkerName,
  /** The discriminator that selects the exe.dev executor. */
  kind: Schema.Literal("exe.dev"),
  /** The positive number of attempts this worker can run concurrently; decoding defaults to 1. */
  maxConcurrentAttempts: MaxConcurrentAttempts,
}) {}

const EnvironmentVariableName = Schema.String.check(
  Schema.isPattern(/^[A-Za-z_][A-Za-z0-9_]*$/u, {
    message: "Expected an environment variable name",
  }),
).pipe(Schema.brand("EnvironmentVariableName"));

/**
 * The credential proxy for an SSH worker on a private network (ADR 0027). Credential fields
 * contain orchestrator environment-variable names, not secret values.
 */
export class WorkerGateway extends Schema.Class<WorkerGateway>("@usine/config/WorkerGateway")({
  /** The private DNS domain used for gateway proxy requests. */
  domain: GatewayDomain,
  /** The SSH destination used to forward the gateway admin API. */
  destination: SshDestination,
  /** The gateway loopback admin port; decoding defaults to 7070. */
  adminPort: GatewayAdminPort.pipe(Schema.withDecodingDefaultKey(Effect.succeed(7070))),
  /** The orchestrator environment variable containing the gateway admin token. */
  adminTokenEnv: EnvironmentVariableName,
  /** The providers whose credentials the gateway injects; decoding defaults to none. */
  llmProviders: Schema.Array(GatewayLlmProvider)
    .check(Schema.isUnique())
    .pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
}) {}

/**
 * The image and resource limits for each SSH attempt container. Preflight derives unset limits
 * from machine capacity after reserving resources for host processes, divided by worker
 * concurrency.
 */
export class WorkerContainer extends Schema.Class<WorkerContainer>("@usine/config/WorkerContainer")(
  {
    /** The container image override, or `None` to use the executor image for this release. */
    image: Schema.OptionFromOptionalKey(ContainerImage),
    /** The CPU limit per attempt container, or `None` to derive it at preflight. */
    cpus: Schema.OptionFromOptionalKey(ContainerCpus),
    /** The memory limit per attempt container in MiB, or `None` to derive it at preflight. */
    memoryMib: Schema.OptionFromOptionalKey(ContainerMemoryMib),
    /** The process limit per attempt container, or `None` to derive it at preflight. */
    pids: Schema.OptionFromOptionalKey(ContainerPids),
  },
) {}

/**
 * Orchestrator environment-variable names for API keys delivered to attempts on provisioned
 * workers. Credentials are read when starting or adding the worker.
 */
export class ProviderApiKeys extends Schema.Class<ProviderApiKeys>("@usine/config/ProviderApiKeys")(
  {
    /**
     * The orchestrator variable containing the Anthropic key to expose as `ANTHROPIC_API_KEY`, or
     * `None`.
     */
    anthropic: Schema.OptionFromOptionalKey(EnvironmentVariableName),
    /**
     * The orchestrator variable containing the OpenAI key to expose as `OPENAI_API_KEY`, or
     * `None`.
     */
    openai: Schema.OptionFromOptionalKey(EnvironmentVariableName),
  },
) {}

const ProviderApiKeysFromYaml = ProviderApiKeys.pipe(
  Schema.withDecodingDefaultKey(Effect.succeed({})),
);

const ProvisionerTimingsFromYaml = ProvisionerTimings.pipe(
  Schema.encodeKeys({
    sshWait: "ssh_wait",
    creationBackoffMin: "creation_backoff_min",
    creationBackoffMax: "creation_backoff_max",
    machineCheckInterval: "machine_check_interval",
  }),
  Schema.withDecodingDefaultKey(Effect.succeed({})),
);

/**
 * Settings for creating one Hetzner Cloud server per attempt from a snapshot and deleting it after
 * the attempt (ADR 0029).
 */
export class HetznerProvisioner extends Schema.Class<HetznerProvisioner>(
  "@usine/config/HetznerProvisioner",
)({
  /** The discriminator that selects the Hetzner Cloud provisioner. */
  provider: Schema.Literal("hetzner"),
  /** The orchestrator environment variable containing the Hetzner Cloud API token. */
  tokenEnv: EnvironmentVariableName,
  /** The Hetzner server type created for each attempt. */
  serverType: HetznerServerType,
  /** The Hetzner location in which to create each server. */
  location: HetznerLocation,
  /** The snapshot ID or description used to create each server. */
  image: HetznerImage,
  /** The private network name, required when using a gateway; `None` omits network attachment. */
  network: Schema.OptionFromOptionalKey(HetznerResourceName),
  /** The firewall name to apply to each server, or `None` to omit it. */
  firewall: Schema.OptionFromOptionalKey(HetznerResourceName),
  /** The SSH key name registered in the Hetzner project. */
  sshKey: HetznerResourceName,
  /** The SSH login on the provisioned server; decoding defaults to `usine`. */
  sshUser: SshUser.pipe(Schema.withDecodingDefaultKey(Effect.succeed("usine"))),
  /** Additional Hetzner labels applied to each server; decoding defaults to an empty map. */
  labels: HetznerLabels.pipe(Schema.withDecodingDefaultKey(Effect.succeed({}))),
  /** Provider key variable names for attempts that use API keys; decoding defaults to none. */
  apiKeys: ProviderApiKeysFromYaml,
  /**
   * SSH readiness, creation backoff, and machine-check intervals in seconds; decoding applies the
   * provisioner defaults.
   */
  timings: ProvisionerTimingsFromYaml,
}) {}

/** The gateway address and OAuth client variables for a Boat sandbox's tailnet join. */
export class BoatTailnet extends Schema.Class<BoatTailnet>("@usine/config/BoatTailnet")({
  /** The gateway address reachable through the tailnet. */
  gatewayAddress: TailnetAddress,
  /** The orchestrator variable containing the Tailscale OAuth client ID. */
  clientIdEnv: EnvironmentVariableName,
  /** The orchestrator variable containing the Tailscale OAuth client secret. */
  clientSecretEnv: EnvironmentVariableName,
}) {}

/** Settings for creating one Boat sandbox per attempt, optionally from a snapshot (ADR 0029). */
export class BoatProvisioner extends Schema.Class<BoatProvisioner>("@usine/config/BoatProvisioner")(
  {
    /** The discriminator that selects the Boat provisioner. */
    provider: Schema.Literal("boat"),
    /** The orchestrator environment variable containing the Boat API token. */
    tokenEnv: EnvironmentVariableName,
    /** The Boat sandbox size; decoding defaults to `default`. */
    size: BoatSize.pipe(Schema.withDecodingDefaultKey(Effect.succeed("default"))),
    /** The Boat snapshot to resume, required with a gateway; `None` uses a new sandbox. */
    snapshot: Schema.OptionFromOptionalKey(BoatSnapshotName),
    /**
     * The gateway address and OAuth variable names for joining the tailnet, or `None` without a
     * gateway.
     */
    tailnet: Schema.OptionFromOptionalKey(
      BoatTailnet.pipe(
        Schema.encodeKeys({
          gatewayAddress: "gateway_address",
          clientIdEnv: "client_id_env",
          clientSecretEnv: "client_secret_env",
        }),
      ),
    ),
    /** Provider key variable names for attempts that use API keys; decoding defaults to none. */
    apiKeys: ProviderApiKeysFromYaml,
    /**
     * SSH readiness, creation backoff, and machine-check intervals in seconds; decoding applies
     * the provisioner defaults.
     */
    timings: ProvisionerTimingsFromYaml,
  },
) {}

/** The provider that creates one machine per attempt for an SSH worker; `provider` selects it. */
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
 * An SSH worker with state under `<root>/workers/<name>`. Configures either a long-lived
 * destination or a provisioner for one machine per attempt; concurrency caps active attempts (ADR
 * 0029).
 */
export class SshWorker extends Schema.Class<SshWorker>("@usine/config/SshWorker")({
  /** The worker identifier, unique within the instance. */
  name: WorkerName,
  /** The discriminator that selects the SSH executor. */
  kind: Schema.Literal("ssh"),
  /** The positive number of attempts this worker can run concurrently; decoding defaults to 1. */
  maxConcurrentAttempts: MaxConcurrentAttempts,
  /** The SSH destination for a long-lived machine; set this or `provisioner`, but not both. */
  destination: Schema.OptionFromOptionalKey(SshDestination),
  /** The provider settings for a machine per attempt, or `None` for a long-lived machine. */
  provisioner: Schema.OptionFromOptionalKey(WorkerProvisionerFromYaml),
  /** The local SSH private-key path; Boat also requires the adjacent `.pub` file. */
  identityFile: Schema.OptionFromOptionalKey(SshIdentityFile),
  /**
   * The SSH port override for a long-lived machine; provisioned workers get the port from their
   * provider.
   */
  port: Schema.OptionFromOptionalKey(SshPort),
  /** The remote base directory for worker state under `workers/<name>`. */
  root: WorkerRoot,
  /** The credential proxy settings, or `None` for direct credential delivery. */
  gateway: Schema.OptionFromOptionalKey(
    WorkerGateway.pipe(
      Schema.encodeKeys({
        adminPort: "admin_port",
        adminTokenEnv: "admin_token_env",
        llmProviders: "llm_providers",
      }),
    ),
  ),
  /** The attempt image and resource limits; decoding defaults to executor-selected values. */
  container: WorkerContainer.pipe(
    Schema.encodeKeys({ memoryMib: "memory_mib" }),
    Schema.withDecodingDefaultKey(Effect.succeed({})),
  ),
}) {}

/** Returns the reason an SSH worker's machine settings conflict, or `undefined` if they don't. */
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
      if (
        Option.isSome(worker.gateway) &&
        (Option.isNone(provisioner.tailnet) || Option.isNone(provisioner.snapshot))
      )
        return `SSH worker "${worker.name}" needs provisioner.tailnet and provisioner.snapshot to use a Boat gateway`;
      if (Option.isSome(provisioner.tailnet) && Option.isNone(worker.gateway))
        return `SSH worker "${worker.name}" sets provisioner.tailnet without a gateway`;
      return Option.isNone(worker.identityFile)
        ? `SSH worker "${worker.name}" has a Boat provisioner and needs identity_file, whose .pub file usine adds to each sandbox`
        : undefined;
  }
};
const HttpsUrl = Schema.URLFromString.check(
  Schema.makeFilter((url: URL) => url.protocol === "https:", { message: "Expected an https URL" }),
  Schema.makeFilter(
    (url: URL) =>
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === "" &&
      url.pathname === "/",
    { message: "Expected the Worker's origin, without a path, credentials, or query string" },
  ),
);

/**
 * An LLM provider API-key variable for credential injection by the deployed Cloudflare Worker. The
 * key stays outside the attempt sandbox.
 */
export class CloudflareLlmProviderKey extends Schema.Class<CloudflareLlmProviderKey>(
  "@usine/config/CloudflareLlmProviderKey",
)({
  /** The LLM provider whose outbound requests need an API key. */
  provider: CloudflareLlmProvider,
  /** The orchestrator environment variable containing the provider API key. */
  apiKeyEnv: EnvironmentVariableName,
}) {}

const uniqueProviders = Schema.makeFilter<ReadonlyArray<CloudflareLlmProviderKey>>(
  (values) => new Set(values.map(({ provider }) => provider)).size === values.length,
  { message: "Expected each provider once" },
);

/**
 * A worker that runs each attempt in a Cloudflare sandbox through a deployed `@usine/cloudflare`
 * Worker. Outbound handlers inject the configured provider credentials (ADR 0029).
 */
export class CloudflareWorker extends Schema.Class<CloudflareWorker>(
  "@usine/config/CloudflareWorker",
)({
  /** The worker identifier, unique within the instance. */
  name: WorkerName,
  /** The discriminator that selects the Cloudflare sandbox executor. */
  kind: Schema.Literal("cloudflare"),
  /** The positive number of attempts this worker can run concurrently; decoding defaults to 1. */
  maxConcurrentAttempts: MaxConcurrentAttempts,
  /**
   * The deployed Cloudflare Worker HTTPS origin, without a path, credentials, query, or fragment.
   */
  workerUrl: HttpsUrl,
  /** The orchestrator variable containing the Cloudflare Access service-token client ID. */
  accessClientIdEnv: EnvironmentVariableName,
  /** The orchestrator variable containing the Cloudflare Access service-token secret. */
  accessClientSecretEnv: EnvironmentVariableName,
  /** The image name configured in the deployed Worker's `containers[].images`. */
  image: CloudflareImageName,
  /** The sandbox container instance type; decoding defaults to `standard-4`. */
  instanceType: CloudflareInstanceType.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed("standard-4")),
  ),
  /**
   * Unique provider API-key variable mappings for outbound credential injection; decoding defaults
   * to none.
   */
  llmProviders: Schema.Array(
    CloudflareLlmProviderKey.pipe(Schema.encodeKeys({ apiKeyEnv: "api_key_env" })),
  )
    .check(uniqueProviders)
    .pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
}) {}

/** A configured worker; `kind` selects the adapter. */
export const Worker = Schema.Union([LocalWorker, ExeDevWorker, SshWorker, CloudflareWorker]);
export type Worker = typeof Worker.Type;

/** Instance-wide defaults for polling, upgrades, and agent attempts. */
export class Settings extends Schema.Class<Settings>("@usine/config/Settings")({
  /** The npm distribution tag for server upgrades; decoding defaults to `latest`. */
  upgradeChannel: UpgradeChannel.pipe(Schema.withDecodingDefaultKey(Effect.succeed("latest"))),
  /**
   * Whether server upgrades are disabled, proposed, or automatic; decoding defaults to `propose`.
   */
  upgradeMode: UpgradeMode.pipe(Schema.withDecodingDefaultKey(Effect.succeed("propose"))),
  /** The interval between GitHub polling cycles, in seconds. */
  pollInterval: PositiveInt.pipe(Schema.withDecodingDefaultKey(Effect.succeed(60))),
  /** The maximum number of child sessions per attempt, counting sequential spawns. */
  maxChildren: ChildSessionBudget.pipe(Schema.withDecodingDefaultKey(Effect.succeed(4))),
  /** The wall-clock limit per attempt, in minutes, or `None` for no limit. */
  maxAttemptMinutes: Schema.OptionFromOptionalKey(PositiveInt),
  /** The token limit per attempt, counting the parent and every child, or `None` for no limit. */
  maxAttemptTokens: Schema.OptionFromOptionalKey(PositiveInt),
  /** The parent model for agents that set none, or `None` to let Pi select it. */
  parentModel: Schema.OptionFromOptionalKey(ModelId),
  /** The parent reasoning effort for agents that set none, or `None` to use the child's effort. */
  parentEffort: Schema.OptionFromOptionalKey(Effort),
}) {}

/**
 * The source of GitHub webhook events that trigger an early poll; polling continues in every mode.
 */
export const Webhooks = Schema.Union([
  Schema.Struct({
    /** Disables webhook hints while regular polling continues. */
    mode: Schema.Literal("off"),
  }),
  Schema.Struct({
    /** Reads GitHub App delivery history for early-poll hints. */
    mode: Schema.Literal("deliveries"),
  }),
  Schema.Struct({
    /** Accepts webhook deliveries at the instance HTTP endpoint. */
    mode: Schema.Literal("endpoint"),
    /** The public URL configured for GitHub webhook delivery. */
    publicUrl: Schema.URLFromString,
  }).pipe(Schema.encodeKeys({ publicUrl: "public_url" })),
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
    upgradeChannel: "upgrade_channel",
    upgradeMode: "upgrade_mode",
    pollInterval: "poll_interval",
    maxChildren: "max_children",
    maxAttemptMinutes: "max_attempt_minutes",
    maxAttemptTokens: "max_attempt_tokens",
    parentModel: "parent_model",
    parentEffort: "parent_effort",
  }),
);

/**
 * Decodes snake_case worker settings and checks SSH destination, provisioner, and gateway
 * constraints.
 */
export const WorkerFromYaml = Schema.Union([
  LocalWorker.pipe(Schema.encodeKeys({ maxConcurrentAttempts: "max_concurrent_attempts" })),
  ExeDevWorker.pipe(Schema.encodeKeys({ maxConcurrentAttempts: "max_concurrent_attempts" })),
  SshWorker.pipe(
    Schema.encodeKeys({
      maxConcurrentAttempts: "max_concurrent_attempts",
      identityFile: "identity_file",
    }),
  ).check(Schema.makeFilter((worker: SshWorker) => sshMachineConflict(worker) ?? true)),
  CloudflareWorker.pipe(
    Schema.encodeKeys({
      maxConcurrentAttempts: "max_concurrent_attempts",
      workerUrl: "worker_url",
      accessClientIdEnv: "access_client_id_env",
      accessClientSecretEnv: "access_client_secret_env",
      instanceType: "instance_type",
      llmProviders: "llm_providers",
    }),
  ),
]);

const ManagedRepos = Schema.Array(ManagedRepo).check(
  uniqueRepositoryNames((repo: ManagedRepo) => repo.name),
);

const Workers = Schema.Array(WorkerFromYaml).check(Schema.isNonEmpty(), uniqueNames);

/** The decoded `usine.yaml`. */
export class UsineConfig extends Schema.Class<UsineConfig>("@usine/config/UsineConfig")(
  Schema.Struct({
    /**
     * The configuration format: 1 for repository lanes, or 2 for projects and qualified loops (ADR
     * 0031).
     */
    version: Schema.Literals([1, 2]),
    /**
     * Projects with disjoint registered repository membership; decoding defaults to none and
     * version 1 requires none.
     */
    projects: Schema.Array(Project).pipe(
      Schema.withDecodingDefaultKey(Effect.succeed([])),
      Schema.withConstructorDefault(Effect.succeed([])),
    ),
    /** Case-insensitively unique labels to create in managed repos; decoding defaults to none. */
    labels: DeclaredLabels.pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
    /** The registry of managed repos, unique by case-insensitive repository name. */
    repos: ManagedRepos,
    /** Instance-wide settings with decoding defaults applied. */
    settings: SettingsFromYaml.pipe(Schema.withDecodingDefaultKey(Effect.succeed({}))),
    /**
     * The ordered, nonempty worker list with unique names; decoding defaults to one local worker
     * named `local`.
     */
    workers: Workers.pipe(
      Schema.withDecodingDefaultKey(Effect.succeed([{ name: "local", kind: "local" }])),
    ),
    /**
     * The source of early-poll hints; decoding defaults to `off` while regular polling continues.
     */
    webhooks: Webhooks.pipe(Schema.withDecodingDefaultKey(Effect.succeed({ mode: "off" }))),
    /** The configured operator login for revision attribution, or `None` when unset. */
    operator: Schema.OptionFromOptionalKey(OperatorLogin),
    /** The OTLP span exporter settings, or `None` to disable export (ADR 0028). */
    tracing: Schema.OptionFromOptionalKey(
      Tracing.pipe(Schema.encodeKeys({ otlpUrl: "otlp_url", serviceName: "service_name" })),
    ),
  }).check(
    Schema.makeFilter(
      ({ version, projects, repos }) => {
        if (version === 1) return projects.length === 0;
        const names = projects.flatMap(({ repositories }) =>
          repositories.map(canonicalRepositoryName),
        );
        const registry = new Set(repos.map(({ name }) => canonicalRepositoryName(name)));
        return (
          new Set(projects.map(({ id }) => id)).size === projects.length &&
          new Set(names).size === names.length &&
          names.every((name) => registry.has(name)) &&
          repos.every(({ lanes }) => lanes.length === 0)
        );
      },
      {
        message:
          "Projects require version 2, unique identifiers, and registered repositories in at most one project; lanes belong to projects",
      },
    ),
  ),
) {}
