import {
  AgentPersona,
  AgentName,
  resolveParentEffort,
  resolveParentModel,
} from "@usine/core/agent";
import { Effort, Harness, ModelId } from "@usine/core/agent/brain";
import { CycleLimit } from "@usine/core/cycle-budget";
import { ApprovalRequirement, LoopName, LoopPermissions } from "@usine/core/loop";
import { OperatorLogin } from "@usine/core/operator";
import { RepositoryName } from "@usine/core/repository";
import { StepName } from "@usine/core/step";
import {
  ContainerCpus,
  ContainerImage,
  ContainerLimits,
  ContainerMemoryMib,
  ContainerPids,
  GatewayAdminPort,
  GatewayDomain,
  GatewayLlmProvider,
  SshDestination,
  SshIdentityFile,
  SshPort,
  WorkerKind,
  WorkerName,
  WorkerRoot,
} from "@usine/core/worker";
import { LaneItemState, LaneName } from "@usine/config/board";
import { RegistryTag, type ManagedRepo, type Worker } from "@usine/config/factory";
import { ConfigFileError, InstancePath } from "@usine/config/file";
import type { LoadedInstance } from "@usine/config/instance";
import { DeclaredLabel, canonicalLabelName, GitHubLabelName } from "@usine/config/label";
import { LoopPriority, PromptTemplate, loopPath } from "@usine/config/loop";
import { boardRepositories, Project, matchesLoop } from "@usine/config/project";
import { Cron, TimeZone, Stream } from "@usine/config/trigger";
import type { EnginePersistenceError } from "@usine/engine/engine";
import { LoopControl } from "@usine/engine/loop-control";
import { RepositoryLabelProjectionReader } from "@usine/engine/repository-label-projection";
import { WorkerCapability } from "@usine/executor";
import { Source } from "@usine/expression/expression-engine";
import { Context, DateTime, Effect, Layer, Match, Option, Schema } from "effect";
import { LabelPreflightFinding } from "../../label-reconciler.ts";
import { PollingTriggers } from "../../polling-triggers.ts";
import { type PreflightCheck, WorkerStatus } from "../../worker-status.ts";
import {
  MachineView,
  machineView,
  ProvisionerView,
  ProvisioningPauseView,
  provisioningPauseView,
  provisionerView,
} from "../machines.ts";

/** A Loop's selector as written: the repositories and registry tags. */
export class LoopSelectorView extends Schema.Class<LoopSelectorView>(
  "@usine/orchestrator/LoopSelectorView",
)({
  /** Explicit repository names in the selector, or null when omitted. */
  repos: Schema.NullOr(Schema.Array(RepositoryName)),
  /** Registry tags in the selector, or null when omitted. */
  tags: Schema.NullOr(Schema.Array(RegistryTag)),
}) {}

/** A parsed Loop file with its runtime pause state. */
export class LoopFileView extends Schema.Class<LoopFileView>("@usine/orchestrator/LoopFileView")({
  /** The project-qualified loop name. */
  name: LoopName,
  /** The loop file path relative to the instance folder. */
  file: InstancePath,
  /** The trigger's `on:` stream. */
  stream: Stream,
  /** The trigger's `if:` expression as written. */
  condition: Source,
  /** A schedule trigger's cron and time zone, or null for the other streams. */
  cron: Schema.NullOr(Cron),
  /** The schedule time zone, or null for issue and pull request triggers. */
  timeZone: Schema.NullOr(TimeZone),
  /** Null when omitted; the loop then applies to every repository in its project. */
  selector: Schema.NullOr(LoopSelectorView),
  /** Project repositories that match the selector, in registry order. */
  repositories: Schema.Array(RepositoryName),
  /** Whether a matched event must wait for operator approval. */
  approval: ApprovalRequirement,
  /** The maximum cycles on one item before an operator reset. */
  maxCycles: CycleLimit,
  /** The GitHub permission level for attempt credentials. */
  permissions: LoopPermissions,
  /** The loop's literal priority or expression, or null for the default zero. */
  priority: Schema.NullOr(LoopPriority),
  /** The step name recorded in runs of this loop. */
  step: StepName,
  /** The referenced agent name. */
  agent: AgentName,
  /** The Markdown prompt template, with its `{{ }}` expressions as written. */
  prompt: PromptTemplate,
  /** Whether runtime loop control prevents new trigger submissions. */
  paused: Schema.Boolean,
  /** Labels the trigger compares against that `usine.yaml` doesn't declare in `labels`. */
  undeclaredLabels: Schema.Array(GitHubLabelName),
}) {}

/** A Loop file that failed to load and opens no Runs, with the failed stage and reason. */
export class QuarantinedLoopView extends Schema.Class<QuarantinedLoopView>(
  "@usine/orchestrator/QuarantinedLoopView",
)({
  /** The file name without its folder and `.md` extension. */
  name: Schema.NonEmptyString,
  /** The invalid file path relative to the instance folder. */
  file: InstancePath,
  /** The failed loading stage and validation diagnostic. */
  error: ConfigFileError,
}) {}

/** A parsed rostered Agent file with the Loops that use it. */
export class AgentFileView extends Schema.Class<AgentFileView>("@usine/orchestrator/AgentFileView")(
  {
    /** The roster name referenced by loops. */
    name: AgentName,
    /** The agent file path relative to the instance folder. */
    file: InstancePath,
    /** The coding-agent CLI used by the child session. */
    harness: Harness,
    /** The model ID supplied to the child harness. */
    model: ModelId,
    /** The child model reasoning effort. */
    effort: Effort,
    /** The file's own parent model and effort, or null if it sets none. */
    parentModel: Schema.NullOr(ModelId),
    /** The explicitly configured parent effort, or null to use the instance or agent default. */
    parentEffort: Schema.NullOr(Effort),
    /** The file's parent model, else `settings.parent_model`. If null, Pi chooses. */
    resolvedParentModel: Schema.NullOr(ModelId),
    /** The file's parent effort, else `settings.parent_effort`, else `effort`. */
    resolvedParentEffort: Effort,
    /** The standing instructions supplied to the agent. */
    persona: AgentPersona,
    /** The loaded Loops that use this Agent. */
    loops: Schema.Array(LoopName),
  },
) {}

/**
 * An Agent file that failed to load and is left out of the roster, with the failed stage and
 * reason.
 */
export class InvalidAgentView extends Schema.Class<InvalidAgentView>(
  "@usine/orchestrator/InvalidAgentView",
)({
  /** The file name without its folder and `.md` extension. */
  name: Schema.NonEmptyString,
  /** The invalid file path relative to the instance folder. */
  file: InstancePath,
  /** The failed loading stage and validation diagnostic. */
  error: ConfigFileError,
}) {}

/**
 * The Gateway in front of an SSH Worker. Includes only the name of the environment variable with
 * its admin token.
 */
export class GatewayView extends Schema.Class<GatewayView>("@usine/orchestrator/GatewayView")({
  /** The gateway domain used for credential-injected requests. */
  domain: GatewayDomain,
  /** The SSH destination used to reach the gateway. */
  destination: SshDestination,
  /** The gateway administration HTTP port. */
  adminPort: GatewayAdminPort,
  /** The environment-variable name for the gateway admin token, never its value. */
  adminTokenEnv: Schema.NonEmptyString,
  /** The model providers whose credentials the gateway injects. */
  llmProviders: Schema.Array(GatewayLlmProvider),
}) {}

/** The current slot usage of a Worker. */
export class WorkerSlotsView extends Schema.Class<WorkerSlotsView>(
  "@usine/orchestrator/WorkerSlotsView",
)({
  /** The number of slots for Attempts: `max_concurrent_attempts` once a reload applied it. */
  capacity: Schema.Int,
  /** The number of occupied attempt slots; it can exceed capacity after a reduction. */
  leased: Schema.Int,
}) {}

/** A passed preflight check, at an ISO instant. */
export class PassedCheckView extends Schema.TaggedClass<PassedCheckView>(
  "@usine/orchestrator/PassedCheckView",
)("Passed", {
  /** The check completion time as an ISO 8601 timestamp. */
  checkedAt: Schema.String,
}) {}

/**
 * A passed check of the Worker's own prerequisites, at an ISO instant, that found it running
 * Attempts without a capability that keeps them apart, such as an SSH Worker without Docker.
 */
export class DegradedCheckView extends Schema.TaggedClass<DegradedCheckView>(
  "@usine/orchestrator/DegradedCheckView",
)("Degraded", {
  /** The check completion time as an ISO 8601 timestamp. */
  checkedAt: Schema.String,
  /** The diagnostic text to show to the operator. */
  message: Schema.String,
}) {}

/**
 * A check that the preflight left for later, at an ISO instant, such as a provisioned Worker's
 * harness checks, which run on its first machine each day.
 */
export class DeferredCheckView extends Schema.TaggedClass<DeferredCheckView>(
  "@usine/orchestrator/DeferredCheckView",
)("Deferred", {
  /** The check completion time as an ISO 8601 timestamp. */
  checkedAt: Schema.String,
  /** The diagnostic text to show to the operator. */
  message: Schema.String,
}) {}

/** A preflight check that found a missing prerequisite or couldn't run, at an ISO instant. */
export class FailedCheckView extends Schema.TaggedClass<FailedCheckView>(
  "@usine/orchestrator/FailedCheckView",
)("Failed", {
  /** The check completion time as an ISO 8601 timestamp. */
  checkedAt: Schema.String,
  /** Null when the check itself failed, such as a timed-out probe. */
  capability: Schema.NullOr(WorkerCapability),
  /** The diagnostic text to show to the operator. */
  message: Schema.String,
}) {}

/** The last worker preflight result, including checks deferred until a machine exists. */
export const PreflightCheckView = Schema.Union([
  PassedCheckView,
  DegradedCheckView,
  DeferredCheckView,
  FailedCheckView,
]);
/** The last worker preflight result, including checks deferred until a machine exists. */
export type PreflightCheckView = typeof PreflightCheckView.Type;

/** The last preflight of one harness on a Worker. */
export class HarnessPreflightView extends Schema.Class<HarnessPreflightView>(
  "@usine/orchestrator/HarnessPreflightView",
)({
  /** The coding-agent CLI checked by preflight. */
  harness: Harness,
  /** The latest preflight outcome for this harness. */
  check: PreflightCheckView,
}) {}

/**
 * The container of each Attempt on an SSH Worker with Docker, from `usine.yaml`. Each limit is
 * null if `usine.yaml` leaves it unset, so preflight derives it from the machine.
 */
export class ContainerView extends Schema.Class<ContainerView>("@usine/orchestrator/ContainerView")(
  {
    /** Null for the default image of this usine release. */
    image: Schema.NullOr(ContainerImage),
    /** The CPU limit per attempt container, or null for the derived default. */
    cpus: Schema.NullOr(ContainerCpus),
    /** The memory limit per attempt container in MiB, or null for the derived default. */
    memoryMib: Schema.NullOr(ContainerMemoryMib),
    /** The process limit per attempt container, or null for the derived default. */
    pids: Schema.NullOr(ContainerPids),
  },
) {}

/** A Worker as declared in `usine.yaml`, with its slot usage and last preflight. */
export class WorkerConfigurationView extends Schema.Class<WorkerConfigurationView>(
  "@usine/orchestrator/WorkerConfigurationView",
)({
  /** The configured worker identity. */
  name: WorkerName,
  /** The executor kind used to run attempts. */
  kind: WorkerKind,
  /** The configured maximum simultaneous attempts on this worker. */
  maxConcurrentAttempts: Schema.Int,
  /** An SSH Worker's connection and root, or null for the other kinds. */
  destination: Schema.NullOr(SshDestination),
  /** The SSH port, or null to use the client default or for a non-SSH worker. */
  port: Schema.NullOr(SshPort),
  /** The SSH private-key path, or null to use normal SSH identity selection. */
  identityFile: Schema.NullOr(SshIdentityFile),
  /** The remote checkout root, or null for a non-SSH worker. */
  root: Schema.NullOr(WorkerRoot),
  /** The credential-injecting gateway settings, or null without a gateway. */
  gateway: Schema.NullOr(GatewayView),
  /** An SSH Worker's Attempt container, used if its machine has Docker; null for the other kinds. */
  container: Schema.NullOr(ContainerView),
  /**
   * The limits of each Attempt container from the last passed preflight that checked the
   * Worker's machine: the ones `usine.yaml` sets and the ones derived from the machine. Null
   * before one, for a machine without Docker, and for the other kinds.
   */
  containerLimits: Schema.NullOr(ContainerLimits).pipe(
    Schema.withConstructorDefault(Effect.succeed(null)),
  ),
  /** A provisioned SSH Worker's provisioner, which creates one machine per Attempt, or null. */
  provisioner: Schema.NullOr(ProvisionerView).pipe(
    Schema.withConstructorDefault(Effect.succeed(null)),
  ),
  /** A provisioned Worker's machines in flight, oldest first. */
  machines: Schema.Array(MachineView).pipe(Schema.withConstructorDefault(Effect.succeed([]))),
  /** A provisioned Worker's last failed machine creation, or null after a success. */
  provisioning: Schema.NullOr(ProvisioningPauseView).pipe(
    Schema.withConstructorDefault(Effect.succeed(null)),
  ),
  /** Null while the scheduler runs no Attempts, as in setup mode. */
  slots: Schema.NullOr(WorkerSlotsView),
  /**
   * The Worker's own prerequisites: machine, Git, memory, Gateway, credentials, and Docker. Null
   * before any preflight. Degraded for an SSH Worker without Docker.
   */
  prerequisites: Schema.NullOr(PreflightCheckView),
  /** Whether a preflight is queued or running for this worker. */
  preflightRunning: Schema.Boolean.pipe(Schema.withConstructorDefault(Effect.succeed(false))),
  /** In harness name order; empty before any harness check. */
  harnesses: Schema.Array(HarnessPreflightView),
}) {}

/** A Worker removed by a reload that still runs Attempts. It's removed when the last one ends. */
export class RemovedWorkerView extends Schema.Class<RemovedWorkerView>(
  "@usine/orchestrator/RemovedWorkerView",
)({
  /** The removed worker identity retained until its attempts end. */
  name: WorkerName,
  /** The number of attempts still running on this removed worker. */
  running: Schema.Int,
}) {}

/** A GitHub label in one repository, as of the last label poll. */
export class LabelStateView extends Schema.Class<LabelStateView>(
  "@usine/orchestrator/LabelStateView",
)({
  /** The GitHub label name. */
  name: GitHubLabelName,
  /** Null until polling has read the repository's labels. */
  onGitHub: Schema.NullOr(Schema.Boolean),
  /** The repository's label color, else the color declared in `labels`, as six hex digits. */
  color: Schema.NullOr(Schema.String),
  /** The GitHub or declared label description, or null without one. */
  description: Schema.NullOr(Schema.String),
  /** Whether `labels` in `usine.yaml` declares the label, so usine creates it if missing. */
  declared: Schema.Boolean,
  /** The reason usine couldn't create or confirm the label at the last poll. */
  failure: Schema.NullOr(LabelPreflightFinding),
}) {}

/** A lane source that routes Items by label. */
export class LabelLaneSourceView extends Schema.TaggedClass<LabelLaneSourceView>(
  "@usine/orchestrator/LabelLaneSourceView",
)("Label", {
  /** The label and its repository creation status for this lane source. */
  label: LabelStateView,
}) {}

/** A lane source that routes Items by issue or pull request state. */
export class StateLaneSourceView extends Schema.TaggedClass<StateLaneSourceView>(
  "@usine/orchestrator/StateLaneSourceView",
)("State", {
  /** The issue or pull request state that selects this lane. */
  state: LaneItemState,
}) {}

/** A GitHub label or item state used to place tasks in a board lane. */
export const LaneSourceView = Schema.Union([LabelLaneSourceView, StateLaneSourceView]);
/** A GitHub label or item state used to place tasks in a board lane. */
export type LaneSourceView = typeof LaneSourceView.Type;

/** One lane declared in a project, with its sources in file order. */
export class LaneConfigurationView extends Schema.Class<LaneConfigurationView>(
  "@usine/orchestrator/LaneConfigurationView",
)({
  /** The configured lane display name. */
  name: LaneName,
  /** The label and state sources in configured order. */
  sources: Schema.Array(LaneSourceView),
}) {}

/** A registered repository with its lanes in Board order, declared labels, and Loops. */
export class RepositoryConfigurationView extends Schema.Class<RepositoryConfigurationView>(
  "@usine/orchestrator/RepositoryConfigurationView",
)({
  /** The registered repository in `owner/name` form. */
  name: RepositoryName,
  /** Registry tags used by loop selectors. */
  tags: Schema.Array(RegistryTag),
  /** Empty if `usine.yaml` declares no lanes, so the Board proposes lanes from the labels. */
  lanes: Schema.Array(LaneConfigurationView),
  /** The labels declared in `usine.yaml`, as this repository has them. */
  declaredLabels: Schema.Array(LabelStateView),
  /** The project loops whose selectors select this repository. */
  loops: Schema.Array(LoopName),
}) {}

/** The `settings`, `operator`, webhooks mode, and `tracing` of `usine.yaml`, with defaults applied. */
export class SettingsView extends Schema.Class<SettingsView>("@usine/orchestrator/SettingsView")({
  /** The configured polling interval in seconds. */
  pollInterval: Schema.Int,
  /** The maximum child sessions per attempt. */
  maxChildren: Schema.Int,
  /** The attempt wall-clock ceiling in minutes, or null without a ceiling. */
  maxAttemptMinutes: Schema.NullOr(Schema.Int),
  /** The attempt token ceiling, or null without a ceiling. */
  maxAttemptTokens: Schema.NullOr(Schema.Int),
  /** The instance default parent model, or null to let Pi choose. */
  parentModel: Schema.NullOr(ModelId),
  /** The instance default parent reasoning effort, or null to use the agent effort. */
  parentEffort: Schema.NullOr(Effort),
  /** The configured operator login, or null when unset. */
  operator: Schema.NullOr(OperatorLogin),
  /** The hint delivery mode: disabled, GitHub delivery polling, or an HTTP endpoint. */
  webhooks: Schema.Literals(["off", "deliveries", "endpoint"]),
  /** The public URL for `endpoint` webhooks, or null for the other modes. */
  webhooksPublicUrl: Schema.NullOr(Schema.String),
  /** The last hint received in this process, or null before any hint. */
  lastHintAt: Schema.NullOr(Schema.String),
  /** The span export settings, or null if `usine.yaml` has no `tracing` block. */
  tracing: Schema.NullOr(Schema.Struct({ otlpUrl: Schema.String, serviceName: Schema.String })),
}) {}

/**
 * The parsed instance folder (Loops, Agents, Workers, repositories, and settings), the files that
 * failed to load, and the runtime state of each.
 */
export class ConfigurationView extends Schema.Class<ConfigurationView>(
  "@usine/orchestrator/ConfigurationView",
)({
  /** The configured projects; defaults to an empty list for older projections. */
  projects: Schema.Array(Project).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed([])),
    Schema.withConstructorDefault(Effect.succeed([])),
  ),
  /** The labels declared for creation in managed repositories. */
  labels: Schema.Array(DeclaredLabel),
  /** The valid loaded loops with runtime pause state. */
  loops: Schema.Array(LoopFileView),
  /** The loop files excluded because loading failed. */
  quarantinedLoops: Schema.Array(QuarantinedLoopView),
  /** The valid loaded agent roster. */
  agents: Schema.Array(AgentFileView),
  /** The agent files excluded because loading failed. */
  invalidAgents: Schema.Array(InvalidAgentView),
  /** Configured workers with current slots and preflight results. */
  workers: Schema.Array(WorkerConfigurationView),
  /** Workers removed from configuration that still have running attempts. */
  removedWorkers: Schema.Array(RemovedWorkerView),
  /** The repository registry with lanes, labels, and matching loops. */
  repositories: Schema.Array(RepositoryConfigurationView),
  /** Instance settings with defaults applied and secrets omitted. */
  settings: SettingsView,
}) {}

const fileStem = (file: InstancePath): string => {
  const name = file.slice(file.lastIndexOf("/") + 1).replace(/\.md$/u, "");
  return name === "" ? file : name;
};

/** Returns the operator API view of a preflight check. */
export const checkView = (check: PreflightCheck): PreflightCheckView =>
  Match.valueTags(check, {
    Passed: ({ checkedAt }) => new PassedCheckView({ checkedAt: DateTime.formatIso(checkedAt) }),
    Degraded: ({ checkedAt, message }) =>
      new DegradedCheckView({ checkedAt: DateTime.formatIso(checkedAt), message }),
    Deferred: ({ checkedAt, message }) =>
      new DeferredCheckView({ checkedAt: DateTime.formatIso(checkedAt), message }),
    Failed: ({ checkedAt, capability, message }) =>
      new FailedCheckView({
        checkedAt: DateTime.formatIso(checkedAt),
        capability: Option.getOrNull(capability),
        message,
      }),
  });

const workerConnection = (worker: Worker) =>
  worker.kind === "ssh"
    ? {
        destination: Option.getOrNull(worker.destination),
        provisioner: provisionerView(worker),
        port: Option.getOrNull(worker.port),
        identityFile: Option.getOrNull(worker.identityFile),
        root: worker.root,
        gateway: Option.match(worker.gateway, {
          onNone: () => null,
          onSome: (gateway) =>
            new GatewayView({
              domain: gateway.domain,
              destination: gateway.destination,
              adminPort: gateway.adminPort,
              adminTokenEnv: gateway.adminTokenEnv,
              llmProviders: gateway.llmProviders,
            }),
        }),
        container: new ContainerView({
          image: Option.getOrNull(worker.container.image),
          cpus: Option.getOrNull(worker.container.cpus),
          memoryMib: Option.getOrNull(worker.container.memoryMib),
          pids: Option.getOrNull(worker.container.pids),
        }),
      }
    : {
        destination: null,
        provisioner: null,
        port: null,
        identityFile: null,
        root: null,
        gateway: null,
        container: null,
      };

const makeOperatorConfiguration = Effect.gen(function* () {
  const controls = yield* LoopControl;
  const repositoryLabels = yield* RepositoryLabelProjectionReader;
  const polling = yield* PollingTriggers;
  const workerStatus = yield* WorkerStatus;

  const repositoryView = Effect.fn("OperatorConfiguration.repository")(function* (
    instance: LoadedInstance,
    repository: ManagedRepo,
    findings: ReadonlyArray<LabelPreflightFinding>,
  ) {
    const projection = yield* repositoryLabels.get(repository.name);
    const catalog = Option.map(
      projection,
      ({ labels }) => new Map(labels.map((label) => [canonicalLabelName(label.name), label])),
    );
    const declared = new Map(
      instance.config.labels.map((label) => [canonicalLabelName(label.name), label]),
    );
    const labelState = (name: GitHubLabelName) => {
      const key = canonicalLabelName(name);
      const found = Option.flatMap(catalog, (labels) => Option.fromNullishOr(labels.get(key)));
      const authored = declared.get(key);
      return new LabelStateView({
        name,
        onGitHub: Option.match(catalog, { onNone: () => null, onSome: () => Option.isSome(found) }),
        color: Option.getOrNull(
          Option.orElse(
            Option.flatMap(found, ({ color }) => color),
            () => Option.flatMap(Option.fromNullishOr(authored), ({ color }) => color),
          ),
        ),
        description: Option.getOrNull(
          Option.orElse(
            Option.flatMap(found, ({ description }) => description),
            () => Option.flatMap(Option.fromNullishOr(authored), ({ description }) => description),
          ),
        ),
        declared: authored !== undefined,
        failure:
          findings.find(
            (finding) =>
              finding.repository === repository.name && canonicalLabelName(finding.label) === key,
          ) ?? null,
      });
    };
    return new RepositoryConfigurationView({
      name: repository.name,
      tags: repository.tags,
      lanes: (
        boardRepositories(instance.config).find(({ name }) => name === repository.name)?.lanes ?? []
      ).map(
        (lane) =>
          new LaneConfigurationView({
            name: lane.name,
            sources: lane.sources.map((source) =>
              "label" in source
                ? new LabelLaneSourceView({ label: labelState(source.label) })
                : new StateLaneSourceView({ state: source.state }),
            ),
          }),
      ),
      declaredLabels: instance.config.labels.map(({ name }) => labelState(name)),
      loops: instance.loops
        .filter((loop) => matchesLoop(instance.config, loop, repository))
        .map(({ name }) => name),
    });
  });

  const view = Effect.fn("OperatorConfiguration.view")(function* (instance: LoadedInstance) {
    const { config } = instance;
    const [states, latestPoll, slots, preflights, inFlight, pauses, checking] = yield* Effect.all(
      [
        controls.states,
        polling.latest,
        workerStatus.slots,
        workerStatus.preflights,
        workerStatus.machines,
        workerStatus.provisioning,
        workerStatus.checking,
      ] as const,
      { concurrency: "unbounded" },
    );
    const paused = new Set(states.filter((state) => state.paused).map((state) => state.loop));
    const findings = Option.match(latestPoll, {
      onNone: () => [],
      onSome: ({ preflightFindings }) => preflightFindings,
    });
    const repositories = yield* Effect.forEach(
      config.repos,
      (repository) => repositoryView(instance, repository, findings),
      { concurrency: 4 },
    );
    const undeclared = (loop: LoopName) =>
      instance.warnings.flatMap((warning) =>
        warning._tag === "UndeclaredTriggerLabelWarning" && warning.loop === loop
          ? [warning.label]
          : [],
      );
    const loops = instance.loops.map(
      (loop) =>
        new LoopFileView({
          name: loop.name,
          file: loopPath(loop.name),
          stream: loop.trigger.on,
          condition: loop.trigger.if,
          cron: loop.trigger.on === "schedule" ? loop.trigger.cron : null,
          timeZone: loop.trigger.on === "schedule" ? loop.trigger.tz : null,
          selector: Option.match(loop.selector, {
            onNone: () => null,
            onSome: ({ repos, tags }) =>
              new LoopSelectorView({
                repos: Option.getOrNull(repos),
                tags: Option.getOrNull(tags),
              }),
          }),
          repositories: config.repos
            .filter((repository) => matchesLoop(instance.config, loop, repository))
            .map(({ name }) => name),
          approval: loop.approval,
          maxCycles: loop.maxCycles,
          permissions: loop.permissions,
          priority: Option.getOrNull(loop.priority),
          step: loop.step,
          agent: loop.agent,
          prompt: loop.body,
          paused: paused.has(loop.name),
          undeclaredLabels: undeclared(loop.name),
        }),
    );
    const agents = instance.agents.map(
      (file) =>
        new AgentFileView({
          name: file.name,
          file: InstancePath.make(`agents/${file.name}.md`),
          harness: file.harness,
          model: file.model,
          effort: file.effort,
          parentModel: Option.getOrNull(file.parentModel),
          parentEffort: Option.getOrNull(file.parentEffort),
          resolvedParentModel: Option.getOrNull(
            resolveParentModel(file.agent, config.settings.parentModel),
          ),
          resolvedParentEffort: resolveParentEffort(file.agent, config.settings.parentEffort),
          persona: file.persona,
          loops: instance.loops.filter(({ agent }) => agent === file.name).map(({ name }) => name),
        }),
    );
    const slotsBy = new Map(slots.map((slot) => [slot.worker, slot]));
    const preflightBy = new Map(preflights.map((preflight) => [preflight.worker, preflight]));
    const declaredWorkers = new Set(config.workers.map(({ name }) => name));
    const workers = config.workers.map((worker) => {
      const slot = slotsBy.get(worker.name);
      const preflight = preflightBy.get(worker.name);
      return new WorkerConfigurationView({
        name: worker.name,
        preflightRunning: checking.has(worker.name),
        kind: worker.kind,
        maxConcurrentAttempts: worker.maxConcurrentAttempts,
        ...workerConnection(worker),
        slots:
          slot === undefined
            ? null
            : new WorkerSlotsView({ capacity: slot.capacity, leased: slot.leased }),
        prerequisites:
          preflight === undefined
            ? null
            : Option.getOrNull(Option.map(preflight.prerequisites, checkView)),
        harnesses: (preflight?.harnesses ?? []).map(
          ({ harness, check }) => new HarnessPreflightView({ harness, check: checkView(check) }),
        ),
        containerLimits:
          preflight === undefined ? null : Option.getOrNull(preflight.containerLimits),
        machines: inFlight.filter((machine) => machine.worker === worker.name).map(machineView),
        provisioning: Option.getOrNull(
          Option.map(
            Option.fromNullishOr(pauses.find((pause) => pause.worker === worker.name)),
            provisioningPauseView,
          ),
        ),
      });
    });
    const { settings, webhooks, tracing } = config;
    const configuration = new ConfigurationView({
      projects: config.projects,
      labels: instance.config.labels,
      loops,
      quarantinedLoops: instance.quarantinedLoops.map(
        ({ file, error }) => new QuarantinedLoopView({ name: fileStem(file), file, error }),
      ),
      agents,
      invalidAgents: instance.invalidAgents.map(
        ({ file, error }) => new InvalidAgentView({ name: fileStem(file), file, error }),
      ),
      workers,
      removedWorkers: slots
        .filter(({ worker, leased }) => !declaredWorkers.has(worker) && leased > 0)
        .map(({ worker, leased }) => new RemovedWorkerView({ name: worker, running: leased })),
      repositories,
      settings: new SettingsView({
        pollInterval: settings.pollInterval,
        maxChildren: settings.maxChildren,
        maxAttemptMinutes: Option.getOrNull(settings.maxAttemptMinutes),
        maxAttemptTokens: Option.getOrNull(settings.maxAttemptTokens),
        parentModel: Option.getOrNull(settings.parentModel),
        parentEffort: Option.getOrNull(settings.parentEffort),
        operator: Option.getOrNull(config.operator),
        webhooks: webhooks.mode,
        lastHintAt: Option.getOrNull(Option.map(yield* polling.lastHint, DateTime.formatIso)),
        webhooksPublicUrl: webhooks.mode === "endpoint" ? webhooks.publicUrl.href : null,
        tracing: Option.match(tracing, {
          onNone: () => null,
          onSome: ({ otlpUrl, serviceName }) => ({ otlpUrl: otlpUrl.href, serviceName }),
        }),
      }),
    });
    yield* Effect.logDebug("Read the configuration view", {
      loops: loops.length,
      quarantinedLoops: configuration.quarantinedLoops.length,
      agents: agents.length,
      invalidAgents: configuration.invalidAgents.length,
      workers: workers.length,
      runningWorkers: slots.length,
      repositories: repositories.length,
    });
    return configuration;
  });

  return { view } as const;
});

/**
 * The operator's view of the parsed instance folder and its runtime state. Reads only memory and
 * the runtime store, never the files.
 */
export class OperatorConfiguration extends Context.Service<
  OperatorConfiguration,
  {
    /**
     * Returns the instance's configuration view with runtime state. Contains no secrets: a
     * Gateway's admin token appears only as its environment variable name.
     */
    readonly view: (
      instance: LoadedInstance,
    ) => Effect.Effect<ConfigurationView, EnginePersistenceError>;
  }
>()("@usine/orchestrator/OperatorConfiguration") {
  /**
   * Provides configuration views using worker status, stored labels, loop control, and trigger
   * status.
   */
  static readonly layer = Layer.effect(OperatorConfiguration, makeOperatorConfiguration);
}
