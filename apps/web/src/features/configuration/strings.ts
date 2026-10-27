import type { Harness } from "@usine/core/agent/brain";
import type { ApprovalRequirement, LoopPermissions } from "@usine/core/loop";
import { CONTAINER_LIMITS, type ContainerLimit, type WorkerKind } from "@usine/core/worker";
import type {
  ConfigurationView,
  ContainerView,
  PreflightCheckView,
  WorkerConfigurationView,
} from "@usine/orchestrator/operator";
import type { OperatorHttpError } from "@usine/orchestrator/operator/http";

export const plural = (count: number, noun: string): string =>
  `${count} ${noun}${count === 1 ? "" : "s"}`;

export const harnessLabel = {
  claude: "Claude Code",
  codex: "Codex",
  pi: "Pi",
} satisfies Record<Harness, string>;

export const workerKindLabel = {
  local: "Local",
  "exe.dev": "exe.dev",
  ssh: "SSH",
  cloudflare: "Cloudflare",
} satisfies Record<WorkerKind, string>;

export const approvalLabel = {
  none: "Not required",
  required: "Required",
} satisfies Record<ApprovalRequirement, string>;

export const permissionsLabel = {
  write: "Write: push and merge",
  read: "Read: review and comment, no push",
} satisfies Record<LoopPermissions, string>;

type Capability = Exclude<Extract<PreflightCheckView, { _tag: "Failed" }>["capability"], null>;

export const capabilityLabel = {
  machine: "machine",
  toolchain: "toolchain",
  memory: "memory",
  "harness-login": "harness login",
  credentials: "credentials",
  gateway: "gateway",
  container: "Docker",
  provider: "provider",
} satisfies Record<Capability, string>;

const containerLimitValue = {
  cpus: (cpus: number) => `${cpus} ${cpus === 1 ? "CPU" : "CPUs"}`,
  memoryMib: (mib: number) => `${mib} MiB`,
  pids: (pids: number) => `${pids} processes`,
} satisfies Record<ContainerLimit, (value: number) => string>;

const containerLimitName = {
  cpus: "CPUs",
  memoryMib: "memory",
  pids: "processes",
} satisfies Record<ContainerLimit, string>;

const conjunction = new Intl.ListFormat("en", { type: "conjunction" });

/** Returns the limits of each Attempt container, such as `2 CPUs, 4096 MiB, 4096 processes`. */
export const containerLimitsLabel = (limits: Readonly<Record<ContainerLimit, number>>): string =>
  CONTAINER_LIMITS.map((limit) => containerLimitValue[limit](limits[limit])).join(", ");

/**
 * Returns the container limits that `usine.yaml` sets, such as `3584 MiB`, and the names of the
 * ones that preflight derives from the machine, such as `CPUs and processes`. Each is null if
 * there are none.
 */
export const containerLimitSources = (container: ContainerView) => {
  const configured = CONTAINER_LIMITS.flatMap((limit) => {
    const value = container[limit];
    return value === null ? [] : [containerLimitValue[limit](value)];
  });
  const derived = CONTAINER_LIMITS.filter((limit) => container[limit] === null);
  return {
    configured: configured.length === 0 ? null : configured.join(", "),
    derived:
      derived.length === 0
        ? null
        : conjunction.format(derived.map((limit) => containerLimitName[limit])),
  };
};

/** Returns the missing capability of a failed check, for example `harness login`, or `check failed` if the check itself failed. */
export const failedCheckLabel = (check: Extract<PreflightCheckView, { _tag: "Failed" }>) =>
  check.capability === null ? "check failed" : capabilityLabel[check.capability];

/**
 * Returns the Worker's location from `usine.yaml`, such as `usine@eu-1`, or for a provisioned
 * Worker, its machines, such as `hetzner cx33 in nbg1, one machine per attempt`.
 */
export const workerPlace = (worker: WorkerConfigurationView): string => {
  switch (worker.kind) {
    case "local":
      return "This machine";
    case "exe.dev":
      return `exe.dev VM ${worker.name}`;
    case "ssh": {
      const { provisioner } = worker;
      if (provisioner === null) return worker.destination ?? "";
      const machine =
        provisioner._tag === "hetzner"
          ? `hetzner ${provisioner.serverType} in ${provisioner.location}`
          : `boat ${provisioner.size}`;
      return `${machine}, one machine per attempt`;
    }
    case "cloudflare":
      return "A Cloudflare sandbox per attempt";
  }
};

interface PreflightSummary {
  readonly state: "passed" | "degraded" | "deferred" | "failed" | "unchecked";
  readonly checkedAt: string | null;
}

/**
 * Returns a summary of the Worker's newest failed check, else its degraded check, else its newest
 * passed or deferred check, else `unchecked`. Of checks at the same instant, the first wins: the
 * prerequisites, then the harnesses in order.
 */
export const preflightSummary = (worker: WorkerConfigurationView): PreflightSummary => {
  const checks = [
    ...(worker.prerequisites === null ? [] : [worker.prerequisites]),
    ...worker.harnesses.map(({ check }) => check),
  ];
  const failed = checks.filter(({ _tag }) => _tag === "Failed");
  const newest = (list: ReadonlyArray<PreflightCheckView>) =>
    list.reduce<string | null>(
      (latest, { checkedAt }) => (latest === null || checkedAt > latest ? checkedAt : latest),
      null,
    );
  if (failed.length > 0) return { state: "failed", checkedAt: newest(failed) };
  const degraded = checks.filter(({ _tag }) => _tag === "Degraded");
  if (degraded.length > 0) return { state: "degraded", checkedAt: newest(degraded) };
  const latest = checks.reduce<PreflightCheckView | undefined>(
    (found, check) => (found === undefined || check.checkedAt > found.checkedAt ? check : found),
    undefined,
  );
  if (latest !== undefined)
    return {
      state: latest._tag === "Deferred" ? "deferred" : "passed",
      checkedAt: latest.checkedAt,
    };
  return { state: "unchecked", checkedAt: null };
};

/** Returns the count text for the Loops heading, for example `5 loops, 1 paused, 1 not loaded`. */
export const loopCounts = (configuration: ConfigurationView): string => {
  const paused = configuration.loops.filter(({ paused: isPaused }) => isPaused).length;
  const quarantined = configuration.quarantinedLoops.length;
  return [
    plural(configuration.loops.length, "loop"),
    ...(paused > 0 ? [`${paused} paused`] : []),
    ...(quarantined > 0 ? [`${quarantined} not loaded`] : []),
  ].join(", ");
};

/** Returns the text shown before a reload error message, or `null` for other errors. */
export const reloadRefusalLead = (error: OperatorHttpError["error"] | undefined): string | null => {
  switch (error) {
    case "FactoryConfigError":
      return "Could not load usine.yaml, the loops folder, or the agents folder.";
    case "RestartRequiredError":
      return "These changes require a restart of usine up.";
    case "ReloadPreflightError":
      return "A worker failed preflight for the added configuration.";
    default:
      return null;
  }
};
