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
  gateway: "Gateway",
} satisfies Record<Capability, string>;

/** What a failed check found missing, such as `harness login`, or that the check itself failed. */
export const failedCheckLabel = (check: Extract<PreflightCheckView, { _tag: "Failed" }>) =>
  check.capability === null ? "check failed" : capabilityLabel[check.capability];

/** Where a Worker runs its Attempts' children, as `usine.yaml` locates it. */
export const workerPlace = (worker: WorkerConfigurationView): string => {
  switch (worker.kind) {
    case "local":
      return "This machine";
    case "exe.dev":
      return `exe.dev VM ${worker.name}`;
    case "ssh":
      return worker.destination ?? "";
  }
};

/** How a Worker's last preflight went, at the newest failed check, else at the newest check. */
interface PreflightSummary {
  readonly state: "passed" | "failed" | "unchecked";
  readonly checkedAt: string | null;
}

/** The newest failed check of a Worker, else its newest check, else none. */
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
  if (checks.length > 0) return { state: "passed", checkedAt: newest(checks) };
  return { state: "unchecked", checkedAt: null };
};

/** Counts beside the Loops heading, such as `5 loops, 1 paused, 1 not loaded`. */
export const loopCounts = (configuration: ConfigurationView): string => {
  const paused = configuration.loops.filter(({ paused: isPaused }) => isPaused).length;
  const quarantined = configuration.quarantinedLoops.length;
  return [
    plural(configuration.loops.length, "loop"),
    ...(paused > 0 ? [`${paused} paused`] : []),
    ...(quarantined > 0 ? [`${quarantined} not loaded`] : []),
  ].join(", ");
};

/** What kind of refusal stopped a reload, before its message. */
export const reloadRefusalLead = (error: OperatorHttpError["error"] | undefined): string | null => {
  switch (error) {
    case "FactoryConfigError":
      return "usine.yaml, or the loops or agents folder, could not be loaded.";
    case "RestartRequiredError":
      return "This change applies only when usine up restarts.";
    case "ReloadPreflightError":
      return "A worker failed preflight for what the reload adds.";
    default:
      return null;
  }
};
