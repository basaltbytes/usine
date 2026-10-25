import type { Harness } from "@usine/core/agent/brain";
import type { ApprovalRequirement, LoopPermissions } from "@usine/core/loop";
import type { WorkerKind } from "@usine/core/worker";
import type {
  ConfigurationView,
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
} satisfies Record<Capability, string>;

/** Returns the missing capability of a failed check, for example `harness login`, or `check failed` if the check itself failed. */
export const failedCheckLabel = (check: Extract<PreflightCheckView, { _tag: "Failed" }>) =>
  check.capability === null ? "check failed" : capabilityLabel[check.capability];

/** Returns the Worker's location from `usine.yaml`. */
export const workerPlace = (worker: WorkerConfigurationView): string => {
  switch (worker.kind) {
    case "local":
      return "This machine";
    case "exe.dev":
      return `exe.dev VM ${worker.name}`;
    case "ssh":
      return worker.destination ?? "";
    case "cloudflare":
      return "A Cloudflare sandbox per attempt";
  }
};

interface PreflightSummary {
  readonly state: "passed" | "degraded" | "failed" | "unchecked";
  readonly checkedAt: string | null;
}

/**
 * Returns a summary of the Worker's newest failed check, else its degraded check, else its newest
 * check, else `unchecked`.
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
  if (checks.length > 0) return { state: "passed", checkedAt: newest(checks) };
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
