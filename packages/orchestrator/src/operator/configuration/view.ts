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
import { LoopPriority, PromptTemplate } from "@usine/config/loop";
import { matchesSelector } from "@usine/config/selector";
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
  repos: Schema.NullOr(Schema.Array(RepositoryName)),
  tags: Schema.NullOr(Schema.Array(RegistryTag)),
}) {}

/** A parsed Loop file with its runtime pause state. */
export class LoopFileView extends Schema.Class<LoopFileView>("@usine/orchestrator/LoopFileView")({
  name: LoopName,
  file: InstancePath,
  /** The trigger's `on:` stream. */
  stream: Stream,
  /** The trigger's `if:` expression as written. */
  condition: Source,
  /** A schedule trigger's cron and time zone, or null for the other streams. */
  cron: Schema.NullOr(Cron),
  timeZone: Schema.NullOr(TimeZone),
  /** Null if the file has no selector, so the Loop applies to every registered repository. */
  selector: Schema.NullOr(LoopSelectorView),
  /** The registered repositories the selector selects, in `usine.yaml` order. */
  repositories: Schema.Array(RepositoryName),
  approval: ApprovalRequirement,
  maxCycles: CycleLimit,
  permissions: LoopPermissions,
  /** The Loop's queue priority, or null if its Runs wait in lane order. */
  priority: Schema.NullOr(LoopPriority),
  step: StepName,
  agent: AgentName,
  /** The Markdown prompt template, with its `{{ }}` expressions as written. */
  prompt: PromptTemplate,
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
  file: InstancePath,
  error: ConfigFileError,
}) {}

/** A parsed rostered Agent file with the Loops that use it. */
export class AgentFileView extends Schema.Class<AgentFileView>("@usine/orchestrator/AgentFileView")(
  {
    name: AgentName,
    file: InstancePath,
    harness: Harness,
    model: ModelId,
    effort: Effort,
    /** The file's own parent model and effort, or null if it sets none. */
    parentModel: Schema.NullOr(ModelId),
    parentEffort: Schema.NullOr(Effort),
    /** The file's parent model, else `settings.parent_model`. If null, Pi chooses. */
    resolvedParentModel: Schema.NullOr(ModelId),
    /** The file's parent effort, else `settings.parent_effort`, else `effort`. */
    resolvedParentEffort: Effort,
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
  file: InstancePath,
  error: ConfigFileError,
}) {}

/**
 * The Gateway in front of an SSH Worker. Includes only the name of the environment variable with
 * its admin token.
 */
export class GatewayView extends Schema.Class<GatewayView>("@usine/orchestrator/GatewayView")({
  domain: GatewayDomain,
  destination: SshDestination,
  adminPort: GatewayAdminPort,
  adminTokenEnv: Schema.NonEmptyString,
  llmProviders: Schema.Array(GatewayLlmProvider),
}) {}

/** The current slot usage of a Worker. */
export class WorkerSlotsView extends Schema.Class<WorkerSlotsView>(
  "@usine/orchestrator/WorkerSlotsView",
)({
  /** The number of slots for Attempts: `max_concurrent_attempts` once a reload applied it. */
  capacity: Schema.Int,
  leased: Schema.Int,
}) {}

/** A passed preflight check, at an ISO instant. */
export class PassedCheckView extends Schema.TaggedClass<PassedCheckView>(
  "@usine/orchestrator/PassedCheckView",
)("Passed", { checkedAt: Schema.String }) {}

/**
 * A passed check of the Worker's own prerequisites, at an ISO instant, that found it running
 * Attempts without a capability that keeps them apart, such as an SSH Worker without Docker.
 */
export class DegradedCheckView extends Schema.TaggedClass<DegradedCheckView>(
  "@usine/orchestrator/DegradedCheckView",
)("Degraded", { checkedAt: Schema.String, message: Schema.String }) {}

/**
 * A check that the preflight left for later, at an ISO instant, such as a provisioned Worker's
 * harness checks, which run on its first machine each day.
 */
export class DeferredCheckView extends Schema.TaggedClass<DeferredCheckView>(
  "@usine/orchestrator/DeferredCheckView",
)("Deferred", { checkedAt: Schema.String, message: Schema.String }) {}

/** A preflight check that found a missing prerequisite or couldn't run, at an ISO instant. */
export class FailedCheckView extends Schema.TaggedClass<FailedCheckView>(
  "@usine/orchestrator/FailedCheckView",
)("Failed", {
  checkedAt: Schema.String,
  /** Null when the check itself failed, such as a timed-out probe. */
  capability: Schema.NullOr(WorkerCapability),
  message: Schema.String,
}) {}

export const PreflightCheckView = Schema.Union([
  PassedCheckView,
  DegradedCheckView,
  DeferredCheckView,
  FailedCheckView,
]);
export type PreflightCheckView = typeof PreflightCheckView.Type;

/** The last preflight of one harness on a Worker. */
export class HarnessPreflightView extends Schema.Class<HarnessPreflightView>(
  "@usine/orchestrator/HarnessPreflightView",
)({
  harness: Harness,
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
    cpus: Schema.NullOr(ContainerCpus),
    memoryMib: Schema.NullOr(ContainerMemoryMib),
    pids: Schema.NullOr(ContainerPids),
  },
) {}

/** A Worker as declared in `usine.yaml`, with its slot usage and last preflight. */
export class WorkerConfigurationView extends Schema.Class<WorkerConfigurationView>(
  "@usine/orchestrator/WorkerConfigurationView",
)({
  name: WorkerName,
  kind: WorkerKind,
  maxConcurrentAttempts: Schema.Int,
  /** An SSH Worker's connection and root, or null for the other kinds. */
  destination: Schema.NullOr(SshDestination),
  port: Schema.NullOr(SshPort),
  identityFile: Schema.NullOr(SshIdentityFile),
  root: Schema.NullOr(WorkerRoot),
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
  /** In harness name order; empty before any harness check. */
  harnesses: Schema.Array(HarnessPreflightView),
}) {}

/** A Worker removed by a reload that still runs Attempts. It's removed when the last one ends. */
export class RemovedWorkerView extends Schema.Class<RemovedWorkerView>(
  "@usine/orchestrator/RemovedWorkerView",
)({
  name: WorkerName,
  running: Schema.Int,
}) {}

/** A GitHub label in one repository, as of the last label poll. */
export class LabelStateView extends Schema.Class<LabelStateView>(
  "@usine/orchestrator/LabelStateView",
)({
  name: GitHubLabelName,
  /** Null until polling has read the repository's labels. */
  onGitHub: Schema.NullOr(Schema.Boolean),
  /** The repository's label color, else the color declared in `labels`, as six hex digits. */
  color: Schema.NullOr(Schema.String),
  description: Schema.NullOr(Schema.String),
  /** Whether `labels` in `usine.yaml` declares the label, so usine creates it if missing. */
  declared: Schema.Boolean,
  /** The reason usine couldn't create or confirm the label at the last poll. */
  failure: Schema.NullOr(LabelPreflightFinding),
}) {}

/** A lane source that routes Items by label. */
export class LabelLaneSourceView extends Schema.TaggedClass<LabelLaneSourceView>(
  "@usine/orchestrator/LabelLaneSourceView",
)("Label", { label: LabelStateView }) {}

/** A lane source that routes Items by issue or pull request state. */
export class StateLaneSourceView extends Schema.TaggedClass<StateLaneSourceView>(
  "@usine/orchestrator/StateLaneSourceView",
)("State", { state: LaneItemState }) {}

export const LaneSourceView = Schema.Union([LabelLaneSourceView, StateLaneSourceView]);
export type LaneSourceView = typeof LaneSourceView.Type;

/** One lane declared in `repos[].lanes`, with its sources in file order. */
export class LaneConfigurationView extends Schema.Class<LaneConfigurationView>(
  "@usine/orchestrator/LaneConfigurationView",
)({
  name: LaneName,
  sources: Schema.Array(LaneSourceView),
}) {}

/** A registered repository with its lanes in Board order, declared labels, and Loops. */
export class RepositoryConfigurationView extends Schema.Class<RepositoryConfigurationView>(
  "@usine/orchestrator/RepositoryConfigurationView",
)({
  name: RepositoryName,
  tags: Schema.Array(RegistryTag),
  /** Empty if `usine.yaml` declares no lanes, so the Board proposes lanes from the labels. */
  lanes: Schema.Array(LaneConfigurationView),
  /** The labels declared in `usine.yaml`, as this repository has them. */
  declaredLabels: Schema.Array(LabelStateView),
  /** The loaded Loops whose selector selects this repository. */
  loops: Schema.Array(LoopName),
}) {}

/** The `settings`, `operator`, webhooks mode, and `tracing` of `usine.yaml`, with defaults applied. */
export class SettingsView extends Schema.Class<SettingsView>("@usine/orchestrator/SettingsView")({
  pollInterval: Schema.Int,
  maxChildren: Schema.Int,
  maxAttemptMinutes: Schema.NullOr(Schema.Int),
  maxAttemptTokens: Schema.NullOr(Schema.Int),
  parentModel: Schema.NullOr(ModelId),
  parentEffort: Schema.NullOr(Effort),
  operator: Schema.NullOr(OperatorLogin),
  webhooks: Schema.Literals(["off", "deliveries", "endpoint"]),
  /** The public URL for `endpoint` webhooks, or null for the other modes. */
  webhooksPublicUrl: Schema.NullOr(Schema.String),
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
  labels: Schema.Array(DeclaredLabel),
  loops: Schema.Array(LoopFileView),
  quarantinedLoops: Schema.Array(QuarantinedLoopView),
  agents: Schema.Array(AgentFileView),
  invalidAgents: Schema.Array(InvalidAgentView),
  workers: Schema.Array(WorkerConfigurationView),
  removedWorkers: Schema.Array(RemovedWorkerView),
  repositories: Schema.Array(RepositoryConfigurationView),
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
      lanes: repository.lanes.map(
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
        .filter((loop) => matchesSelector(loop.selector, repository))
        .map(({ name }) => name),
    });
  });

  const view = Effect.fn("OperatorConfiguration.view")(function* (instance: LoadedInstance) {
    const { config } = instance;
    const [states, latestPoll, slots, preflights, inFlight, pauses] = yield* Effect.all(
      [
        controls.states,
        polling.latest,
        workerStatus.slots,
        workerStatus.preflights,
        workerStatus.machines,
        workerStatus.provisioning,
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
          file: InstancePath.make(`loops/${loop.name}.md`),
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
            .filter((repository) => matchesSelector(loop.selector, repository))
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
  static readonly layer = Layer.effect(OperatorConfiguration, makeOperatorConfiguration);
}
