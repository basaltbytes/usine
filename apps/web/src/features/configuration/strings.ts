import { UpgradeChannel, UpgradeMode } from "@usine/core/upgrade";
import type { Harness } from "@usine/core/agent/brain";
import type { ApprovalRequirement, LoopPermissions } from "@usine/core/loop";
import { CONTAINER_LIMITS, type ContainerLimit, type WorkerKind } from "@usine/core/worker";
import type {
  ConfigurationView,
  ContainerView,
  PreflightCheckView,
  WorkerConfigurationView,
} from "@usine/orchestrator/operator";

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

export const provisionedHarnessCheckDescription =
  "Harness checks run on the first machine, then on the next machine created after the configured interval since the last successful check.";

export const approvalLabel = {
  none: "Not required",
  required: "Required",
} satisfies Record<ApprovalRequirement, string>;

export const permissionsLabel = {
  write: "Write: push and merge",
  read: "Read: review and comment, no push",
} satisfies Record<LoopPermissions, string>;

type Capability = Exclude<Extract<PreflightCheckView, { _tag: "Failed" }>["capability"], null>;

const capabilityLabel = {
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

export const upgradesTitle = "Server upgrades";
export const upgradeWhenIdle = "Upgrade when idle";
export const upgradeNow = "Upgrade now";
export const upgradeChanges = "View changes";
export const upgradeIdleHelp =
  "Wait for running attempts to finish. No new attempt starts while waiting.";
export const upgradeNowHelp = "Restart now. Running attempts reattach after the server restarts.";
export const upgradeUnsupported =
  "App upgrades require a global npm install managed by systemd. Use usine status and usine upgrade for this instance.";
export const upgradeCurrent = "No newer version is available.";
export const upgradeOff = "Upgrade checks are off.";
export const upgradeWaiting = "Waiting for running attempts to finish. No new attempts will start.";
export const upgradeInstalling =
  "Installing and restarting. This page reconnects when the server answers.";
export const upgradeRolledBack = (previous: string, target: string, reason: string) =>
  `Upgrade to ${target} failed. Restored ${previous}. ${reason}`;

export const upgradeRunningLabel = "Running version";
export const upgradeChannelLabel = "Channel";
export const upgradeModeLabel = "Mode";
export const upgradeAvailable = (version: string) => `Version ${version} is available.`;

export const editorCopy = {
  noLabels: "No labels",
  addLabel: "Choose New to declare a label.",
  localOperator: "Local operator",
  edit: "Edit",
  save: "Save",
  saving: "Saving…",
  cancel: "Cancel",
  delete: "Delete",
  confirmDelete: "Confirm delete",
  new: "New",
  history: "History",
  revert: "Revert",
  confirmRevert: "Confirm revert",
  message: "Message (optional)",
  name: "Name",
  source: "Configuration text",
  draft: "Unsaved draft",
  reload: "Reload text",
  deletedConflict:
    "This entity was deleted. Reload text to start a new version; your draft remains available below.",
  conflict:
    "The configuration changed since this editor opened. Review the newer revision before saving. Reloading keeps your unsaved draft below for copying.",
  paused: "New loops start paused. Review the loop before resuming it.",
  emptyHistory: "No revisions",
  more: "Older revisions",
  loading: "Loading…",
  noDiff: "No text changes",
  saved: "Saved",
  deleted: "Deleted",
  reverted: "Revision reverted",
  deleteWarning: (name: string) => `Delete ${name}?`,
  references: (names: readonly string[]) =>
    names.length === 0
      ? "No loops or projects reference this entity."
      : `Referenced by: ${names.join(", ")}.`,
  revertWarning:
    "Revert restores every entity in this revision. Later changes can prevent a revert.",
  alreadyExists: "This name already exists. Open the entity to edit it.",
  create: (kind: string) => `New ${kind}`,
  revision: (number: number) => `Revision ${number}`,
};

export const agentCopy = {
  add: "Choose New to add an agent.",
  parentOverride: "Set on this agent",
  parentModelUnset: "Not set on this agent or in settings",
};

export const addLoop = "Choose New to add a loop. New loops start paused.";

export const addRepository = "Choose New to register a repository.";

export const preflightTiming =
  "At startup, and when a revision adds workers, slots, or an agent with a new harness, model, or effort";

export const formCopy = {
  text: "Edit as text",
  form: "Edit as form",
  choose: "Choose…",
  name: "Name",
  identity: "The name identifies this entity. Choose a name when creating it.",
  harness: "Harness",
  effort: "Effort",
  model: "Model",
  persona: "Persona",
  modelHint: "Suggestions use models configured for this harness. Any model ID is accepted.",
  preview: "Preview persona",
  hidePreview: "Hide preview",
  loading: "Loading choices…",
  secret: "Enter an environment variable name. The value lives in .env.",
  restartWorker:
    "For an existing worker, changes other than the slot count require a restart. Slot changes apply live.",
  restartSettings: "Changes to webhooks or tracing require a restart.",
  derived: "Derived at preflight when unset",
  lastPreflight: "Last preflight",
  repositories: "Repository",
  noRepositories: "All installation repositories are registered.",
  tags: "Tags (comma-separated)",
  lanes: "Lanes",
  addLane: "Add lane",
  removeLane: "Remove lane",
  laneName: "Lane name",
  labels: "Labels",
  states: "Item states",
  noLabels: "No labels on this repository",
  moveUp: "Move up",
  moveDown: "Move down",
  reorder: "Reorder lane",
  orderHint: "Drag a lane handle, or focus it and use Space, Arrow Up or Arrow Down, then Space.",
  gateway: "Gateway",
  provisioner: "Machine provider",
  existing: "Existing machine",
  container: "Container",
  add: "Add",
  remove: "Remove",
  key: "Key",
  value: "Value",
  providerKeys: "Provider environment variables",
};

export const settingsFormFields = [
  {
    path: "settings.poll_interval",
    label: "Poll interval (seconds)",
    kind: "number",
    description: "Seconds between the starts of two GitHub poll cycles.",
  },
  {
    path: "settings.max_children",
    label: "Maximum child sessions",
    kind: "number",
    description: "Maximum child sessions per attempt. Starting one more fails the attempt.",
  },
  {
    path: "settings.max_attempt_minutes",
    label: "Attempt limit (minutes)",
    kind: "number",
    description:
      "Minutes an attempt may run before the runaway guard fails it. Leave blank for no ceiling.",
  },
  {
    path: "settings.max_attempt_tokens",
    label: "Attempt token limit",
    kind: "number",
    description: "Tokens per attempt, parent and children combined. Leave blank for no ceiling.",
  },
  {
    path: "settings.parent_model",
    label: "Parent model",
    description: "Parent model when the agent sets none. Leave blank to let Pi choose.",
  },
  {
    path: "settings.parent_effort",
    label: "Parent effort",
    description: "Parent effort when the agent sets none. Leave blank to use the agent's effort.",
  },
  {
    path: "settings.upgrade_channel",
    label: "Upgrade channel",
    options: UpgradeChannel.literals,
    description: "npm channel used to check for upgrades.",
  },
  {
    path: "settings.upgrade_mode",
    label: "Upgrade mode",
    options: UpgradeMode.literals,
    description: "Disable upgrade checks, propose upgrades, or install automatically when idle.",
  },
  {
    path: "operator",
    label: "Operator GitHub login",
    description:
      "The login recorded on approvals and messages, and the only login that can answer an ask on GitHub.",
  },
  {
    path: "webhooks.mode",
    label: "Webhooks mode",
    options: ["off", "deliveries", "endpoint"],
    description:
      "Parsed and validated; GitHub changes are read by polling. A change requires a restart.",
  },
] as const;

export const settingsExtraCopy = {
  publicUrl: "Public webhook URL",
  publicUrlHint: "Where GitHub would deliver webhooks.",
  tracing: "Export traces",
  otlp: "OTLP URL",
  otlpHint: "Collector endpoint that receives every span as OTLP/HTTP protobuf.",
  service: "Service name",
  serviceHint: "The service.name resource attribute of every exported span.",
};

export const workerFormCopy = {
  kind: "Worker kind",
  slots: "Concurrent attempts",
  slotsHint: "Maximum attempts running on this worker at once.",
  root: "Working directory",
  destination: "SSH destination",
  identity: "SSH identity file",
  port: "SSH port",
  image: "Container image",
  cpus: "Container CPUs",
  memory: "Container memory (MiB)",
  pids: "Container process limit",
  url: "Worker URL",
  clientId: "Access client ID variable",
  clientSecret: "Access client secret variable",
  instanceType: "Instance type",
  token: "Provider token variable",
  serverType: "Server type",
  location: "Location",
  snapshot: "Snapshot",
  network: "Network",
  firewall: "Firewall",
  sshKey: "SSH key name",
  sshUser: "SSH user",
  size: "Sandbox size",
  domain: "Gateway domain",
  gatewayDestination: "Gateway SSH destination",
  adminPort: "Gateway admin port",
  adminToken: "Gateway token variable",
  providers: "Gateway LLM providers (comma-separated)",
  tailnet: "Join a tailnet",
  gatewayAddress: "Tailnet gateway address",
  tailnetId: "Tailnet client ID variable",
  tailnetSecret: "Tailnet client secret variable",
  anthropic: "Anthropic API key variable",
  openai: "OpenAI API key variable",
  labels: "Machine labels",
  sshWait: "SSH wait (seconds)",
  backoffMin: "Minimum creation backoff (seconds)",
  backoffMax: "Maximum creation backoff (seconds)",
  checkInterval: "Machine check interval (seconds)",
};

export const loopFormCopy = {
  stream: "Stream",
  condition: "Condition (CEL)",
  prompt: "Prompt (Markdown)",
  repositories: "Repositories",
  tags: "Tags",
  allRepositories: "Leave both selectors empty to include every repository.",
  approval: "Require approval",
  step: "Step name",
  agent: "Agent",
  cycles: "Cycle limit",
  permissions: "Permissions",
  cron: "Cron",
  timeZone: "Time zone",
  checking: "Checking…",
  checked: "No problems found",
  preview: "Preview",
  previewing: "Loading preview…",
  completions: "Payload fields",
  completionHint: "Choose a field to insert at the cursor. Use Ctrl+Space to show fields.",
  count: (total: number, shown: number) =>
    `${total} matching ${total === 1 ? "item" : "items"}${total > shown ? ` · showing ${shown}` : ""}`,
  sample: "Render prompt",
  rendered: "Rendered prompt",
  empty: "No stored items match this loop.",
  noData: (repositories: readonly string[]) =>
    `No stored items for this stream yet: ${repositories.join(", ")}.`,
  schedule: "Schedule loops run on ticks. There are no polled items to preview.",
  confirm: "Resume loop",
  resume: "Resume",
  cancel: "Cancel",
  resumeHint: "Resuming allows this loop to open runs for matching items.",
  paused: "New loops start paused. Resume the loop after reviewing its preview.",
};
