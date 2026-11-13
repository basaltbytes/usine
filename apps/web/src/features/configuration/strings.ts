import type { LoopApproval } from "@usine/config/loop";
import { UpgradeChannel, UpgradeMode } from "@usine/core/upgrade";
import { CoordinatorKind } from "@usine/core/agent";
import type { LoopPermissions } from "@usine/core/loop";
import { CONTAINER_LIMITS, type ContainerLimit, type WorkerKind } from "@usine/core/worker";
import type {
  ConfigurationView,
  ContainerView,
  PreflightCheckView,
  StatisticsWindow,
  WorkerConfigurationView,
} from "@usine/orchestrator/operator";
import type { ConfigurationEntityKind } from "@usine/config/configuration";
import { windowPhrase } from "~/lib/strings";

export const plural = (count: number, noun: string): string =>
  `${count} ${noun}${count === 1 ? "" : "s"}`;

export const workerKindLabel = {
  local: "Local",
  "exe.dev": "exe.dev",
  ssh: "SSH",
  cloudflare: "Cloudflare",
} satisfies Record<WorkerKind, string>;

/** The heading of what a Worker's last machine preflight found missing that Attempts run without. */
export const preflightFindingsLabel = "Preflight findings";

export const provisionedHarnessCheckDescription =
  "Harness checks run on the first machine, then on the next machine created after the configured interval since the last successful check.";

export const approvalLabel = (approval: LoopApproval): string =>
  approval === "none" ? "Not required" : approval === "required" ? "Required" : "Conditional";

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
          : provisioner._tag === "boxd"
            ? ["boxd", provisioner.size, provisioner.region]
                .filter((part) => part !== null)
                .join(" ")
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

const entityNoun = {
  loop: "loop",
  agent: "agent",
  worker: "worker",
  project: "project",
  repository: "repository",
  label: "label",
  binding: "role binding",
  settings: "settings",
} satisfies Record<ConfigurationEntityKind, string>;

/** The empty state of each list page: a title and what one entry does. */
export const emptyListCopy = {
  loop: {
    title: "No loops",
    description:
      "A loop starts an agent run for each item in a project that matches a trigger. New loops start paused.",
  },
  agent: {
    title: "No agents",
    description: "An agent sets the instructions, harness, model, and effort for runs.",
  },
  worker: {
    title: "No workers",
    description: "A worker is a machine that runs attempts, such as this machine or an SSH host.",
  },
  project: {
    title: "No projects",
    description: "A project groups repositories under one board, with the loops that run on them.",
  },
  repository: {
    title: "No repositories",
    description:
      "usine polls each registered repository for the issues and pull requests on boards.",
  },
  label: {
    title: "No labels",
    description: "usine creates each declared label in every managed repository.",
  },
  binding: {
    title: "No role bindings",
    description:
      "A role binding grants a member admin access to the instance, or a viewer, operator, or maintainer role on one project.",
  },
} satisfies Record<
  Exclude<ConfigurationEntityKind, "settings">,
  { title: string; description: string }
>;

export const noProjectForLoop = "Creating a loop requires a project.";
export const openProjects = "Open Projects";

export const editorCopy = {
  localOperator: "Local operator",
  edit: "Edit",
  save: "Save",
  saving: "Saving…",
  cancel: "Cancel",
  delete: "Delete",
  confirmDelete: "Confirm delete",
  continue: "Continue",
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
  create: (kind: ConfigurationEntityKind) => `New ${entityNoun[kind]}`,
  revision: (number: number) => `Revision ${number}`,
};

export const supervisorCopy = {
  notConfigured: "Not configured",
  unsetEffect: "The instance runs no supervisor. Set settings.supervisor to start one.",
  effect:
    "The harness, model, and effort of the supervisor, which observes and operates the factory with the operator tools that a member's token allows, and reads the instance's source.",
  toolsKey: "Supervisor tools",
  readTools: "Read and search",
  readToolsEffect:
    "The harness lists only its tools that read and search files, in the supervisor's read-only container.",
  ownTools: "All of the harness's own tools",
  ownToolsEffect: (reason: string) =>
    `The harness's own tools stay on, and the read-only container limits what they reach: ${reason}.`,
  sandboxKey: "Supervisor container",
  available: "Available",
  availableEffect:
    "Supervisor sessions run in a read-only container on the orchestrator host, with no network but the model route.",
  unavailable: "Unavailable",
};

export const coordinatorCopy = {
  effect: {
    session:
      "A parent session coordinates each attempt, unless the agent file sets coordinator: events.",
    events:
      "Rules on lifecycle events coordinate each attempt, with no parent session, unless the agent file sets coordinator: session.",
  } satisfies Record<CoordinatorKind, string>,
  label: "Coordinator",
  agentHint: "Leave blank to use settings.coordinator.",
  fromSettings: "From settings.coordinator",
};

export const agentCopy = {
  override: "Set on this agent",
  parentModelUnset: "Not set on this agent or in settings",
  models: "Models",
  modelsNote: "Merged tasks, by the model of the first attempt with this agent",
  modelsError: "Could not load the model statistics",
};

/** Returns text such as `No merged task with an attempt by this agent in the last 30 days`. */
export const noModelTasksLine = (window: StatisticsWindow): string =>
  `No merged task with an attempt by this agent ${windowPhrase(window)}`;

export const preflightTiming =
  "At startup, on demand, and when a revision changes worker slots or adds a worker or agent brain";

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
    "For an existing worker, changes other than the slot count and Paused require a restart. Those apply live.",
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
    path: "settings.max_background_wait_minutes",
    label: "Background wait limit (minutes)",
    kind: "number",
    description:
      "Minutes a child that answered waits for its background tasks to start a turn. Then it returns its answer and its background tasks stop. Leave blank for no limit.",
  },
  {
    path: "settings.coordinator",
    label: "Coordinator",
    options: CoordinatorKind.literals,
    description:
      "What coordinates attempts when the agent sets none: a parent session, or rules on events.",
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
      "Deliveries mode checks webhook summaries every 10 seconds. A change requires a restart.",
  },
] as const;

export const settingsExtraCopy = {
  supervisor: "Run a supervisor",
  supervisorHarness: "Supervisor harness",
  supervisorHarnessHint:
    "Runs the supervisor in a read-only container on the orchestrator, with the instance's gateway credential. The harness must serve usine tool sets.",
  supervisorModel: "Supervisor model",
  supervisorEffort: "Supervisor effort",
  publicUrl: "Public webhook URL",
  publicUrlHint: "The full public webhook URL, including /webhooks/github.",
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
  paused: "Paused: take no new attempts; running attempts finish",
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
  size: "Machine size",
  boxdSizeHint:
    "The snapshot's size as <vcpu>x<GiB>, such as 2x8 or 1x32. Preflight fails when the snapshot has another size. Leave empty to accept the snapshot's size.",
  endpoint: "Endpoint",
  endpointHint:
    "The account endpoint of a self-hosted or bring-your-own-cloud boxd cluster, such as https://boxd.example.com:9443. Leave empty for the hosted service.",
  region: "Region",
  regionHint:
    "A region enabled for your boxd org, as listed by boxd manage regions. fra and nyc are the hosted regions. Leave empty to create machines where the endpoint runs them.",
  isolated: "Isolated",
  egress: "Egress allowlist (comma-separated, empty for unrestricted)",
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
  priority: "Priority",
  priorityHint:
    "An integer or CEL expression returning int. Higher values go first; blank means 0.",
  evaluatedPriority: (value: number) => `Priority ${value}`,
  stream: "Stream",
  condition: "Condition (CEL)",
  prompt: "Prompt (Markdown)",
  repositories: "Repositories",
  tags: "Tags",
  allRepositories: "Leave both selectors empty to include every repository in the project.",
  approval: "Approval",
  approvalNone: "Not required",
  approvalRequired: "Always required",
  approvalConditional: "When a condition is true",
  approvalCondition: "Approval condition (CEL)",
  approvalHint:
    "A true condition or an evaluation error requires approval. False allows the run to start.",
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

export const projectCopy = {
  invalidId: "Use lowercase letters, numbers, and hyphens for the project ID",
  title: "Projects",
  chooseProject: "Choose a project",
  missing: "Project not found",
  board: "Open the board",
  lanes: "Lanes",
  unassignedProject: "Not assigned to a project",
  id: "Project ID",
  name: "Display name",
  repositories: "Repositories",
  choose: "Add a repository",
  unassigned: "No unassigned repositories",
  lanesHint: "Lane labels apply to every repository in the project.",
  up: "Move repository up",
  down: "Move repository down",
  remove: "Remove repository",
  project: "Project",
};

export const webhookStatusCopy = {
  mode: {
    off: "Self-write hints are enabled. A mode change requires a restart.",
    deliveries:
      "Checks delivery summaries every 10 seconds to refresh repositories sooner. A mode change requires a restart.",
    endpoint:
      "Receives signed webhook deliveries to refresh repositories sooner. A mode change requires a restart.",
  },
  lastHint: "Last hint received",
  never: "None since startup",
  hintEffect:
    "The last self-write or webhook hint received since startup. Polling runs independently.",
};

export const upgradeCancel = "Cancel pending upgrade";
export const upgradeTarget = (version: string): string => `Requested version: ${version}`;
export const runPreflightLabel = "Run preflight";
export const runningPreflightLabel = "Running preflight…";
export const preflightBusyReason = "Available after all attempts end";
export const preflightSetupReason = "Available after GitHub App setup";
export const preflightRunningReason = "A preflight is already running";
export const preflightCommand = (worker: string) => `Run preflight on ${worker}`;

export const bindingCopy = {
  title: "Role bindings",
  member: "Member",
  instance: "Instance",
  role: "Role",
  scope: "Scope",
  unenrolledMember: "Member not enrolled",
  roles: {
    admin: "Admin",
    viewer: "Viewer",
    operator: "Operator",
    maintainer: "Maintainer",
  },
  noMembers: "Add a member before creating a binding.",
  members: "Open Members",
  loadingMembers: "Loading members…",
  retryMembers: "Retry loading members",
  instanceHint: "Instance scope grants admin access. Project scope grants access to one project.",
};

export const machineReuseCopy = {
  idle: "Idle",
  limits: "Reuse stops at the configured attempt or age limit",
  attempts: "Attempts",
};

export const historyCopy = {
  title: "Configuration history",
  view: "View history",
  forEntity: (key: string) => `View history for ${key}`,
  changedBy: (actor: string) => `Changed by ${actor}`,
  unavailable: "· Last change unavailable",
  today: "Today",
  yesterday: "Yesterday",
  revision: "Revision",
  noMessage: "No message",
  kinds: {
    loop: "Loop",
    agent: "Agent",
    worker: "Worker",
    project: "Project",
    repository: "Repository",
    label: "Label",
    binding: "Role binding",
    settings: "Settings",
  },
};

export const labelDetailCopy = {
  label: "Label",
  description: "Description",
  noDescription: "No description",
};
