import { type Brand, Effect, Schema } from "effect";

/** A worker's kebab-case name in the instance configuration. */
export const WorkerName = Schema.String.check(
  Schema.isPattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u, {
    message: "Expected a kebab-case worker name",
  }),
).pipe(Schema.brand("WorkerName"));

export type WorkerName = typeof WorkerName.Type;

/** The supported worker adapters: local, exe.dev, SSH, and Cloudflare. */
export const WORKER_KINDS = ["local", "exe.dev", "ssh", "cloudflare"] as const;
/** The adapter used to run attempts on a worker. */
export const WorkerKind = Schema.Literals(WORKER_KINDS);
export type WorkerKind = typeof WorkerKind.Type;

/**
 * The GitHub bot login that an Attempt writes as: the factory's GitHub App on local, SSH, and
 * Cloudflare Workers, or the exe.dev GitHub integration on exe.dev Workers (ADR 0011).
 */
export const BotLogin = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\[bot\]$/u, {
    message: "Expected a GitHub bot login: <slug>[bot]",
  }),
).pipe(Schema.brand("BotLogin"));
export type BotLogin = typeof BotLogin.Type;

/** The user ID of a GitHub App's bot account. It differs from the App ID. */
export const BotUserId = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).pipe(
  Schema.brand("BotUserId"),
);
export type BotUserId = typeof BotUserId.Type;

/**
 * A GitHub App's bot account. The factory App's account authors and commits every Attempt's
 * commits on every Worker kind (ADR 0011).
 */
export class BotAccount extends Schema.Class<
  BotAccount,
  Brand.Brand<"@usine/core/worker/BotAccount">
>("BotAccount")({
  /** The GitHub bot login used to author attempt commits. */
  login: BotLogin,
  /** The bot account's user ID, used in its noreply email address. */
  id: BotUserId,
}) {
  /** The ID-based noreply address, which GitHub links to the account even after a rename. */
  get noreplyEmail(): string {
    return `${String(this.id)}+${this.login}@users.noreply.github.com`;
  }
}

/**
 * The `ssh` destination: a host name, IPv4 or IPv6 address, or SSH config Host alias, optionally
 * prefixed with `user@`. Rejects values that `ssh` could parse as an option, such as
 * `-oProxyCommand=...`.
 */
export const SshDestination = Schema.String.check(
  Schema.isPattern(
    /^(?:[A-Za-z0-9._-]+@)?(?:[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?|[0-9A-Fa-f]{0,4}(?::[0-9A-Fa-f]{0,4}){2,7})$/u,
    {
      message: "Expected an SSH destination: a host name or address, optionally prefixed by a user",
    },
  ),
).pipe(Schema.brand("SshDestination"));
export type SshDestination = typeof SshDestination.Type;

/** The SSH server's TCP port, from 1 through 65535. */
export const SshPort = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65_535 })).pipe(
  Schema.brand("SshPort"),
);
export type SshPort = typeof SshPort.Type;

/** The `ssh` private key path, absolute or starting with `~/`. */
export const SshIdentityFile = Schema.String.check(
  Schema.isPattern(/^(?:\/|~\/)[!-~]+$/u, {
    message: "Expected an absolute or ~/ key path without spaces or control characters",
  }),
).pipe(Schema.brand("SshIdentityFile"));
export type SshIdentityFile = typeof SshIdentityFile.Type;

/**
 * The absolute directory on the Worker's machine that contains `workers/<worker>`, with cached
 * clones, Attempt checkouts, and Attempt credentials.
 */
export const WorkerRoot = Schema.String.check(
  Schema.isPattern(/^(?:\/[!-.0-~]+)+$/u, {
    message: "Expected an absolute directory without spaces, control characters, or a trailing /",
  }),
).pipe(Schema.brand("WorkerRoot"));
export type WorkerRoot = typeof WorkerRoot.Type;

/**
 * The Gateway's private DNS domain, which serves `git.<domain>` for GitHub, `llm.<domain>` for
 * LLM providers, and `<domain>` for the forward proxy
 * (ADR 0027).
 */
export const GatewayDomain = Schema.String.check(
  Schema.isPattern(
    /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u,
    { message: "Expected a lowercase DNS domain" },
  ),
).pipe(Schema.brand("GatewayDomain"));
export type GatewayDomain = typeof GatewayDomain.Type;

/** The Gateway admin API port on the Gateway's loopback interface (`USINE_GATEWAY_ADMIN_PORT`), used through an SSH forward. */
export const GatewayAdminPort = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: 65_535 }),
).pipe(Schema.brand("GatewayAdminPort"));
export type GatewayAdminPort = typeof GatewayAdminPort.Type;

/** A provider of attempt API keys. */
export const GatewayLlmProvider = Schema.Literals(["anthropic", "openai"]);
export type GatewayLlmProvider = typeof GatewayLlmProvider.Type;

/** The wire protocol of a gateway credential slot. */
export const GatewayLlmProtocol = Schema.Literals(["anthropic-messages", "openai-responses"]);
export type GatewayLlmProtocol = typeof GatewayLlmProtocol.Type;

/**
 * The kind of LLM provider credential that the Gateway stores, as reported by its admin API, or
 * that a Cloudflare Worker's outbound handler holds, always `api-key`. `api-key` is billed at
 * API rates; `subscription` uses a plan: a Claude plan from `claude setup-token`, or a ChatGPT
 * plan from `codex login`
 * (ADR 0013).
 */
export const GatewayCredentialKind = Schema.Literals(["api-key", "subscription"]);
export type GatewayCredentialKind = typeof GatewayCredentialKind.Type;

/**
 * A container image reference, `[registry/]repository[:tag][@digest]`, such as
 * `ghcr.io/basaltbytes/usine-worker:claude-2.1.308-codex-0.159.2`. Rejects values that the
 * container CLI could parse as an option.
 */
export const ContainerImage = Schema.String.check(
  Schema.isPattern(/^[a-z0-9][A-Za-z0-9._/:@-]{0,254}$/u, {
    message:
      "Expected a container image reference, such as ghcr.io/owner/image:tag, without spaces or a leading dash",
  }),
).pipe(Schema.brand("ContainerImage"));
export type ContainerImage = typeof ContainerImage.Type;

/**
 * The ID that the container runtime gives a container when it creates it: 64 lowercase hex
 * digits. A start of a stopped container keeps it.
 */
export const ContainerId = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{64}$/u, {
    message: "Expected a container ID of 64 lowercase hex digits",
  }),
).pipe(Schema.brand("ContainerId"));
export type ContainerId = typeof ContainerId.Type;

/** The CPUs a container may use, such as `1.5`. */
export const ContainerCpus = Schema.Finite.check(Schema.isGreaterThan(0)).pipe(
  Schema.brand("ContainerCpus"),
);
export type ContainerCpus = typeof ContainerCpus.Type;

/** A container's memory limit in MiB. */
export const ContainerMemoryMib = Schema.Int.check(Schema.isGreaterThanOrEqualTo(256)).pipe(
  Schema.brand("ContainerMemoryMib"),
);
export type ContainerMemoryMib = typeof ContainerMemoryMib.Type;

/** The capacity of a memory-backed container scratch filesystem in MiB. */
export const ContainerScratchMib = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).pipe(
  Schema.brand("ContainerScratchMib"),
);
export type ContainerScratchMib = typeof ContainerScratchMib.Type;

/** The maximum number of processes and threads in a container. */
export const ContainerPids = Schema.Int.check(Schema.isGreaterThanOrEqualTo(64)).pipe(
  Schema.brand("ContainerPids"),
);
export type ContainerPids = typeof ContainerPids.Type;

/** The CPU, memory, and process limits of one Attempt container. */
export class ContainerLimits extends Schema.Class<
  ContainerLimits,
  Brand.Brand<"@usine/core/worker/ContainerLimits">
>("ContainerLimits")({
  /** The CPU capacity available to the container, including fractional CPUs. */
  cpus: ContainerCpus,
  /** The container's memory ceiling in MiB, at least 256. */
  memoryMib: ContainerMemoryMib,
  /** The maximum processes and threads in the container, at least 64. */
  pids: ContainerPids,
}) {}

/** The fields of `ContainerLimits`, in the order that logs and the web UI give them. */
export const CONTAINER_LIMITS = ["cpus", "memoryMib", "pids"] as const satisfies ReadonlyArray<
  keyof typeof ContainerLimits.fields
>;
/** A container resource limit name used to index `ContainerLimits`. */
export type ContainerLimit = (typeof CONTAINER_LIMITS)[number];

/**
 * A Cloudflare container instance type. From `lite` (1/16 vCPU, 256 MiB, 2 GB disk) to
 * `standard-4` (4 vCPU, 12 GiB, 20 GB disk).
 */
export const CloudflareInstanceType = Schema.Literals([
  "lite",
  "basic",
  "standard-1",
  "standard-2",
  "standard-3",
  "standard-4",
]);
export type CloudflareInstanceType = typeof CloudflareInstanceType.Type;

/**
 * The name of an image in the Cloudflare Worker's `containers[].images`, which the Worker starts
 * each Attempt's sandbox from.
 */
export const CloudflareImageName = Schema.String.check(
  Schema.isPattern(/^[A-Za-z_][A-Za-z0-9_]{0,62}$/u, {
    message:
      "Expected an image name of letters, digits, and underscores that doesn't start with a digit",
  }),
).pipe(Schema.brand("CloudflareImageName"));
export type CloudflareImageName = typeof CloudflareImageName.Type;

/**
 * An LLM provider whose API key the Cloudflare Worker's outbound handlers hold for an Attempt:
 * `anthropic` for Claude Code and `openai` for Codex.
 */
export const CloudflareLlmProvider = Schema.Literals(["anthropic", "openai"]);
export type CloudflareLlmProvider = typeof CloudflareLlmProvider.Type;

/** The cloud provider that creates one machine per Attempt for a provisioned SSH Worker. */
export const MachineProvider = Schema.Literals(["hetzner", "boat", "boxd"]);
export type MachineProvider = typeof MachineProvider.Type;

/**
 * A machine's ID at its provider: a Hetzner Cloud server ID, such as `52341896`, or a Boat
 * sandbox ID, such as `bx_23456789`.
 */
export const MachineId = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9_-]{1,64}$/u, { message: "Expected a provider machine ID" }),
).pipe(Schema.brand("MachineId"));
export type MachineId = typeof MachineId.Type;

/** A Hetzner Cloud server type, such as `cx33` or `cpx32`. */
export const HetznerServerType = Schema.String.check(
  Schema.isPattern(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u, {
    message: "Expected a Hetzner server type, such as cx33",
  }),
).pipe(Schema.brand("HetznerServerType"));
export type HetznerServerType = typeof HetznerServerType.Type;

/** A Hetzner Cloud location, such as `fsn1`, `nbg1`, or `hel1`. */
export const HetznerLocation = Schema.String.check(
  Schema.isPattern(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u, {
    message: "Expected a Hetzner location, such as nbg1",
  }),
).pipe(Schema.brand("HetznerLocation"));
export type HetznerLocation = typeof HetznerLocation.Type;

/**
 * The image of each Hetzner Cloud server: a snapshot's ID or description, or a system image's
 * name, such as `debian-13`.
 */
export const HetznerImage = Schema.String.check(
  Schema.isPattern(/^[!-~](?:[ -~]{0,253}[!-~])?$/u, {
    message: "Expected a Hetzner image ID, snapshot description, or image name",
  }),
).pipe(Schema.brand("HetznerImage"));
export type HetznerImage = typeof HetznerImage.Type;

/** The name of a Hetzner Cloud resource, such as a network or an SSH key. */
export const HetznerResourceName = Schema.String.check(
  Schema.isPattern(/^[!-~](?:[ -~]{0,126}[!-~])?$/u, {
    message: "Expected a Hetzner resource name without control characters",
  }),
).pipe(Schema.brand("HetznerResourceName"));
export type HetznerResourceName = typeof HetznerResourceName.Type;

const HETZNER_LABEL_KEY =
  /^(?:[a-z0-9A-Z](?:[-_.a-z0-9A-Z]*[a-z0-9A-Z])?\/)?[a-z0-9A-Z](?:[-_.a-z0-9A-Z]{0,61}[a-z0-9A-Z])?$/u;
const HETZNER_LABEL_VALUE = /^(?:[a-z0-9A-Z](?:[-_.a-z0-9A-Z]{0,61}[a-z0-9A-Z])?)?$/u;

/** Returns whether `value` is a valid Hetzner Cloud label value. */
export const isHetznerLabelValue = (value: string): boolean => HETZNER_LABEL_VALUE.test(value);

/**
 * Extra labels for each Hetzner Cloud server, by Hetzner's label rules. Keys that start with
 * `usine-` are usine's own.
 */
export const HetznerLabels = Schema.Record(
  Schema.String,
  Schema.String.check(
    Schema.isPattern(HETZNER_LABEL_VALUE, { message: "Expected a Hetzner label value" }),
  ),
).check(
  Schema.makeFilter((labels: Readonly<Record<string, string>>) => {
    const keys = Object.keys(labels);
    const invalid = keys.find((key) => !HETZNER_LABEL_KEY.test(key));
    if (invalid !== undefined) return `Expected a Hetzner label key, not "${invalid}"`;
    const reserved = keys.find((key) => key.startsWith("usine-"));
    return reserved === undefined
      ? true
      : `Expected a label key that doesn't start with usine-, which usine sets itself, not "${reserved}"`;
  }),
);
export type HetznerLabels = typeof HetznerLabels.Type;

/** A Unix user name for SSH, such as `usine`. */
export const SshUser = Schema.String.check(
  Schema.isPattern(/^[a-z_][a-z0-9_-]{0,31}$/u, { message: "Expected a Unix user name" }),
).pipe(Schema.brand("SshUser"));
export type SshUser = typeof SshUser.Type;

/**
 * A Boat machine size: `small`, `default` (4 vCPU and 8 GB), `large`, or `xlarge`, which needs
 * a Boat plan of $100 per month or more.
 */
export const BoatSize = Schema.Literals(["small", "default", "large", "xlarge"]);
export type BoatSize = typeof BoatSize.Type;

/** A Boat saved snapshot name, excluding names reserved by its API. */
export const BoatSnapshotName = Schema.String.check(
  Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,62}$/u),
  Schema.makeFilter(
    (name: string) =>
      !["latest", "tree", "pull", "rm", "save", "current", "self", "new"].includes(name),
    { message: "Expected a non-reserved Boat snapshot name" },
  ),
).pipe(Schema.brand("BoatSnapshotName"));
export type BoatSnapshotName = typeof BoatSnapshotName.Type;

/** A boxd snapshot's captured CPU and memory size. */
export const BoxdSize = Schema.Literals(["1x4", "2x8", "4x16", "8x32"]);
export type BoxdSize = typeof BoxdSize.Type;

/**
 * The id of the boxd region containing a machine and its snapshot, such as `fra` or `nyc`.
 * boxd lists its regions, so any lowercase id is accepted here and checked at preflight.
 */
export const BoxdRegion = Schema.String.check(
  Schema.isPattern(/^[a-z0-9][a-z0-9_-]{0,62}$/u, {
    message: "Expected a lowercase boxd region id, such as fra",
  }),
).pipe(Schema.brand("BoxdRegion"));
export type BoxdRegion = typeof BoxdRegion.Type;

/** A lowercase boxd snapshot name of at most 63 characters. */
export const BoxdSnapshotName = Schema.String.check(
  Schema.isPattern(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u),
).pipe(Schema.brand("BoxdSnapshotName"));
export type BoxdSnapshotName = typeof BoxdSnapshotName.Type;

/**
 * IPv4 ranges that boxd refuses in an egress allowlist: this network, private (RFC 1918), CGNAT,
 * loopback, link-local, multicast, and reserved addresses.
 */
const BOXD_RESERVED_RANGES = [
  "0.0.0.0/8",
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "224.0.0.0/4",
  "240.0.0.0/4",
];

/** The shortest prefix length of a public address range that an egress allowlist accepts. */
const BOXD_SHORTEST_PREFIX = 8;

/** Parses `a.b.c.d` or `a.b.c.d/p` into an unsigned 32-bit address and a prefix length. */
const ipv4Range = (entry: string): { address: number; prefix: number } | undefined => {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?:\/(\d{1,2}))?$/u.exec(entry);
  if (match === null) return undefined;
  const octets = match.slice(1, 5).map(Number);
  const prefix = match[5] === undefined ? 32 : Number(match[5]);
  if (octets.some((octet) => octet > 255) || prefix > 32) return undefined;
  const address = octets.reduce((value, octet) => value * 256 + octet, 0);
  return { address, prefix };
};

/** The network address of `address` under a prefix of length `prefix`. */
const networkOf = (address: number, prefix: number): number =>
  prefix === 0 ? 0 : (address & (0xffffffff << (32 - prefix))) >>> 0;

const formatIpv4 = (address: number): string =>
  [24, 16, 8, 0].map((shift) => (address >>> shift) & 255).join(".");

/**
 * Returns why boxd refuses the address entry `entry`, or `undefined` if `entry` is a public address
 * or range that boxd accepts, or not an address.
 */
const boxdEgressAddressRefusal = (entry: string): string | undefined => {
  const range = ipv4Range(entry);
  if (range === undefined) return undefined;
  const network = networkOf(range.address, range.prefix);
  if (network !== range.address)
    return `${entry} has host bits set; did you mean ${formatIpv4(network)}/${range.prefix}?`;
  const reserved = BOXD_RESERVED_RANGES.find((candidate) => {
    const other = ipv4Range(candidate);
    if (other === undefined) return false;
    const shared = Math.min(other.prefix, range.prefix);
    return networkOf(other.address, shared) === networkOf(network, shared);
  });
  if (reserved !== undefined) return `${entry} overlaps the reserved range ${reserved}`;
  return range.prefix < BOXD_SHORTEST_PREFIX
    ? `${entry} is wider than /${BOXD_SHORTEST_PREFIX}, which no public allowlist entry needs`
    : undefined;
};

/** Whether `entry` is an IPv4 address or CIDR range rather than a host name or `none`. */
export const isBoxdEgressAddress = (entry: string): boolean => ipv4Range(entry) !== undefined;

/**
 * An entry of a boxd machine's egress allowlist: a lowercase ASCII host name such as
 * `registry.npmjs.org`, `*.` and a domain for its subdomains, a public IPv4 address, a public CIDR
 * range with a prefix length of 8 or more, or `none`, which admits nothing. boxd admits HTTP and
 * HTTPS by host name and other traffic by address. Like boxd, the schema refuses a repeated or
 * inner wildcard, a range with host bits set, and an address that overlaps a private, CGNAT,
 * loopback, link-local, multicast, or reserved range. It also refuses a range with a prefix
 * length under 8, which no public allowlist entry needs.
 */
export const BoxdEgressEntry = Schema.String.check(
  Schema.makeFilter(
    (entry: string) =>
      !entry.includes("*") ||
      /^\*\.[^*]+$/u.test(entry) ||
      `${entry} is an invalid wildcard; use one *. at the start`,
  ),
  Schema.isPattern(
    /^(?:none|(?:\*\.)?(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?|(?:(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])(?:\/(?:3[0-2]|[12]?[0-9]))?)$/u,
    {
      message:
        "Expected a lowercase host name with a dot, *. and a domain, an IPv4 address or CIDR range, or none",
    },
  ),
  Schema.makeFilter((entry: string) => boxdEgressAddressRefusal(entry) ?? true),
).pipe(Schema.brand("BoxdEgressEntry"));
export type BoxdEgressEntry = typeof BoxdEgressEntry.Type;

/**
 * A boxd machine's complete egress allowlist: 1 to 256 unique entries, where `none` must be the
 * only entry.
 */
export const BoxdEgressAllowlist = Schema.Array(BoxdEgressEntry).check(
  Schema.isMinLength(1, {
    message: "Expected at least one entry; use none to admit nothing, or omit egress",
  }),
  Schema.isMaxLength(256),
  Schema.isUnique(),
  Schema.makeFilter(
    (entries: ReadonlyArray<string>) =>
      entries.length === 1 ||
      !entries.includes("none") ||
      "Expected none as the only entry, since boxd ignores it next to other entries",
  ),
);
export type BoxdEgressAllowlist = typeof BoxdEgressAllowlist.Type;

/**
 * Returns whether `entries` admits `host`. A `*.` entry is treated as admitting its domain too,
 * so a check for a host that must stay unreachable errs on the side of refusing the list.
 */
export const boxdEgressAdmits = (entries: ReadonlyArray<string>, host: string): boolean =>
  entries.some((entry) =>
    entry.startsWith("*.")
      ? host === entry.slice(2) || host.endsWith(entry.slice(1))
      : entry === host,
  );

/** A Tailscale IPv4 address in 100.64.0.0/10. */
export const TailnetAddress = Schema.String.check(
  Schema.isPattern(
    /^100\.(?:6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])\.(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])$/u,
    { message: "Expected a Tailscale IPv4 address in 100.64.0.0/10" },
  ),
).pipe(Schema.brand("TailnetAddress"));
export type TailnetAddress = typeof TailnetAddress.Type;

/** Positive whole seconds for provisioner waits and check intervals. */
export const ProvisionerSeconds = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: 2_147_483 }),
).pipe(Schema.brand("ProvisionerSeconds"));
export type ProvisionerSeconds = typeof ProvisionerSeconds.Type;

const secondsWithDefault = (seconds: number) =>
  ProvisionerSeconds.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(seconds)),
    Schema.withConstructorDefault(Effect.succeed(ProvisionerSeconds.make(seconds))),
  );

/** Provisioner timings, in seconds. Creation failures double their delay up to the maximum. */
export class ProvisionerTimings extends Schema.Class<
  ProvisionerTimings,
  Brand.Brand<"@usine/core/worker/ProvisionerTimings">
>("ProvisionerTimings")(
  Schema.Struct({
    /** Seconds to wait for SSH readiness after machine creation; defaults to 600. */
    sshWait: secondsWithDefault(600),
    /** The initial delay after a creation failure, in seconds; defaults to 30. */
    creationBackoffMin: secondsWithDefault(30),
    /** The maximum creation retry delay, in seconds; at least `creationBackoffMin`, defaulting to 600. */
    creationBackoffMax: secondsWithDefault(600),
    /** Seconds between machine capability checks; defaults to 86400. */
    machineCheckInterval: secondsWithDefault(86_400),
  }).check(
    Schema.makeFilter(
      (value) =>
        value.creationBackoffMin <= value.creationBackoffMax ||
        "Creation backoff minimum must not exceed its maximum",
    ),
  ),
) {}

/** Positive compact duration in seconds, minutes, hours, or days, up to 24 days. */
export const MachineMaxAge = Schema.String.check(
  Schema.isPattern(/^[1-9][0-9]{0,5}[smhd]$/u),
  Schema.makeFilter(
    (value) => ageMillis(value) <= 2_073_600_000 || "Machine age must not exceed 24 days",
  ),
).pipe(Schema.brand("MachineMaxAge"));
export type MachineMaxAge = typeof MachineMaxAge.Type;

const ageMillis = (value: string): number =>
  Number.parseInt(value, 10) *
  (value.endsWith("d")
    ? 86_400_000
    : value.endsWith("h")
      ? 3_600_000
      : value.endsWith("m")
        ? 60_000
        : 1_000);

/** Maximum number of attempts served by one provisioned machine. */
export const MachineAttemptLimit = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: 100_000 }),
).pipe(Schema.brand("MachineAttemptLimit"));
export type MachineAttemptLimit = typeof MachineAttemptLimit.Type;

/** Limits for consecutive attempts on a provisioned machine. */
export class ProvisionerReuse extends Schema.Class<
  ProvisionerReuse,
  Brand.Brand<"@usine/core/worker/ProvisionerReuse">
>("ProvisionerReuse")({
  attempts: MachineAttemptLimit,
  maxAge: MachineMaxAge,
}) {
  get maxAgeMillis(): number {
    return ageMillis(this.maxAge);
  }
}
