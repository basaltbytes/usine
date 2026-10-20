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
import { canonicalLabelName, GitHubLabelName } from "@usine/config/label";
import { PromptTemplate } from "@usine/config/loop";
import { matchesSelector } from "@usine/config/selector";
import { Cron, TimeZone } from "@usine/config/trigger";
import type { EnginePersistenceError } from "@usine/engine/engine";
import { LoopControl } from "@usine/engine/loop-control";
import { RepositoryLabelProjectionReader } from "@usine/engine/repository-label-projection";
import { WorkerCapability } from "@usine/executor";
import { Source } from "@usine/expression/expression-engine";
import { Context, DateTime, Effect, Layer, Match, Option, Schema } from "effect";
import { LabelPreflightFinding } from "../label-reconciler.ts";
import { PollingTriggers } from "../polling-triggers.ts";
import { type PreflightCheck, WorkerStatus } from "../worker-status.ts";

/** A Loop's selector as its file states it: the repositories and the registry tags it names. */
export class LoopSelectorView extends Schema.Class<LoopSelectorView>(
  "@usine/orchestrator/LoopSelectorView",
)({
  repos: Schema.NullOr(Schema.Array(RepositoryName)),
  tags: Schema.NullOr(Schema.Array(RegistryTag)),
}) {}

/** A loaded Loop file as the orchestrator parsed it, with its runtime pause state. */
export class LoopFileView extends Schema.Class<LoopFileView>("@usine/orchestrator/LoopFileView")({
  name: LoopName,
  file: InstancePath,
  /** The stream the trigger watches, its `on:`. */
  stream: Schema.Literals(["issue", "pr", "schedule"]),
  /** The trigger's `if:` expression as written. */
  condition: Source,
  /** A schedule trigger's cron and time zone; null for the other streams. */
  cron: Schema.NullOr(Cron),
  timeZone: Schema.NullOr(TimeZone),
  /** Null when the file has no selector, so the Loop applies to every registered repository. */
  selector: Schema.NullOr(LoopSelectorView),
  /** The registered repositories the selector selects, in `usine.yaml` order. */
  repositories: Schema.Array(RepositoryName),
  approval: ApprovalRequirement,
  maxCycles: CycleLimit,
  permissions: LoopPermissions,
  step: StepName,
  agent: AgentName,
  /** The Markdown prompt template, with its `{{ }}` expressions as written. */
  prompt: PromptTemplate,
  paused: Schema.Boolean,
  /** Labels the trigger compares Items against that `labels` in `usine.yaml` does not declare. */
  undeclaredLabels: Schema.Array(GitHubLabelName),
}) {}

/** A Loop file that opens no Runs because it failed to load, with the stage and reason. */
export class QuarantinedLoopView extends Schema.Class<QuarantinedLoopView>(
  "@usine/orchestrator/QuarantinedLoopView",
)({
  /** The file's name without its folder and `.md`, which names the Loop once it loads. */
  name: Schema.NonEmptyString,
  file: InstancePath,
  error: ConfigFileError,
}) {}

/** A rostered Agent file as the orchestrator parsed it, with the Loops that name it. */
export class AgentFileView extends Schema.Class<AgentFileView>("@usine/orchestrator/AgentFileView")(
  {
    name: AgentName,
    file: InstancePath,
    harness: Harness,
    model: ModelId,
    effort: Effort,
    /** The file's own parent model and effort; null when it sets none. */
    parentModel: Schema.NullOr(ModelId),
    parentEffort: Schema.NullOr(Effort),
    /**
     * The parent model an Attempt of this Agent runs: the file's, else
     * `settings.parent_model`; null leaves the choice to Pi.
     */
    resolvedParentModel: Schema.NullOr(ModelId),
    /** The parent effort an Attempt runs: the file's, else `settings.parent_effort`, else `effort`. */
    resolvedParentEffort: Effort,
    persona: AgentPersona,
    /** The loaded Loops that name this Agent. */
    loops: Schema.Array(LoopName),
  },
) {}

/** An Agent file left out of the roster because it failed to load, with the stage and reason. */
export class InvalidAgentView extends Schema.Class<InvalidAgentView>(
  "@usine/orchestrator/InvalidAgentView",
)({
  /** The file's name without its folder and `.md`, which names the Agent once it loads. */
  name: Schema.NonEmptyString,
  file: InstancePath,
  error: ConfigFileError,
}) {}

/**
 * The Gateway in front of an SSH Worker. Its admin token is named by the
 * environment variable it is read from and never travels itself.
 */
export class GatewayView extends Schema.Class<GatewayView>("@usine/orchestrator/GatewayView")({
  domain: GatewayDomain,
  destination: SshDestination,
  adminPort: GatewayAdminPort,
  adminTokenEnv: Schema.NonEmptyString,
  llmProviders: Schema.Array(GatewayLlmProvider),
}) {}

/** How many Attempts hold a Worker's slots now. */
export class WorkerSlotsView extends Schema.Class<WorkerSlotsView>(
  "@usine/orchestrator/WorkerSlotsView",
)({
  /** The slots the scheduler runs Attempts on, `max_concurrent_attempts` once a reload applied it. */
  capacity: Schema.Int,
  leased: Schema.Int,
}) {}

/** A preflight check that found what it verifies ready, at an ISO instant. */
export class PassedCheckView extends Schema.TaggedClass<PassedCheckView>(
  "@usine/orchestrator/PassedCheckView",
)("Passed", { checkedAt: Schema.String }) {}

/** A preflight check that found a prerequisite missing or could not run, at an ISO instant. */
export class FailedCheckView extends Schema.TaggedClass<FailedCheckView>(
  "@usine/orchestrator/FailedCheckView",
)("Failed", {
  checkedAt: Schema.String,
  /** Null when the check itself failed, such as a timed-out probe. */
  capability: Schema.NullOr(WorkerCapability),
  message: Schema.String,
}) {}

/** The outcome of one preflight check. */
export const PreflightCheckView = Schema.Union([PassedCheckView, FailedCheckView]);
export type PreflightCheckView = typeof PreflightCheckView.Type;

/** The last preflight of one harness on a Worker. */
export class HarnessPreflightView extends Schema.Class<HarnessPreflightView>(
  "@usine/orchestrator/HarnessPreflightView",
)({
  harness: Harness,
  check: PreflightCheckView,
}) {}

/** A Worker as `usine.yaml` declares it, with its slots in use and its last preflight. */
export class WorkerConfigurationView extends Schema.Class<WorkerConfigurationView>(
  "@usine/orchestrator/WorkerConfigurationView",
)({
  name: WorkerName,
  kind: WorkerKind,
  maxConcurrentAttempts: Schema.Int,
  /** An SSH Worker's connection and root; null for the other kinds. */
  destination: Schema.NullOr(SshDestination),
  port: Schema.NullOr(SshPort),
  identityFile: Schema.NullOr(SshIdentityFile),
  root: Schema.NullOr(WorkerRoot),
  gateway: Schema.NullOr(GatewayView),
  /** Null while the scheduler runs no Attempt on it, as in setup mode. */
  slots: Schema.NullOr(WorkerSlotsView),
  /** The Worker's own prerequisites: its machine, Git, memory, Gateway, and credentials. Null before any preflight decided them. */
  prerequisites: Schema.NullOr(PreflightCheckView),
  /** In harness name order; empty before any harness was checked. */
  harnesses: Schema.Array(HarnessPreflightView),
}) {}

/** A Worker a reload removed while Attempts still run on it; it leaves when the last one ends. */
export class RemovedWorkerView extends Schema.Class<RemovedWorkerView>(
  "@usine/orchestrator/RemovedWorkerView",
)({
  name: WorkerName,
  running: Schema.Int,
}) {}

/** A GitHub label as one repository has it, from the labels polling last read there. */
export class LabelStateView extends Schema.Class<LabelStateView>(
  "@usine/orchestrator/LabelStateView",
)({
  name: GitHubLabelName,
  /** Null until polling has read the repository's labels. */
  onGitHub: Schema.NullOr(Schema.Boolean),
  /** The repository's color for the label, else the color `labels` declares, as six hex digits. */
  color: Schema.NullOr(Schema.String),
  description: Schema.NullOr(Schema.String),
  /** Whether `labels` in `usine.yaml` declares it, so usine creates it when it is missing. */
  declared: Schema.Boolean,
  /** Why usine could not create or confirm it at the last poll. */
  failure: Schema.NullOr(LabelPreflightFinding),
}) {}

/** A lane source that routes Items with a label. */
export class LabelLaneSourceView extends Schema.TaggedClass<LabelLaneSourceView>(
  "@usine/orchestrator/LabelLaneSourceView",
)("Label", { label: LabelStateView }) {}

/** A lane source that routes Items in an issue or pull request state. */
export class StateLaneSourceView extends Schema.TaggedClass<StateLaneSourceView>(
  "@usine/orchestrator/StateLaneSourceView",
)("State", { state: LaneItemState }) {}

export const LaneSourceView = Schema.Union([LabelLaneSourceView, StateLaneSourceView]);
export type LaneSourceView = typeof LaneSourceView.Type;

/** One lane `repos[].lanes` declares, with its sources in file order. */
export class LaneConfigurationView extends Schema.Class<LaneConfigurationView>(
  "@usine/orchestrator/LaneConfigurationView",
)({
  name: LaneName,
  sources: Schema.Array(LaneSourceView),
}) {}

/** A registered repository with its lanes in Board order, its declared labels, and its Loops. */
export class RepositoryConfigurationView extends Schema.Class<RepositoryConfigurationView>(
  "@usine/orchestrator/RepositoryConfigurationView",
)({
  name: RepositoryName,
  tags: Schema.Array(RegistryTag),
  /** Empty when `usine.yaml` declares no lanes, so the Board proposes lanes from the labels. */
  lanes: Schema.Array(LaneConfigurationView),
  /** The labels `labels` in `usine.yaml` declares, as this repository has them. */
  declaredLabels: Schema.Array(LabelStateView),
  /** The loaded Loops whose selector selects this repository. */
  loops: Schema.Array(LoopName),
}) {}

/** `settings`, `operator`, and the webhooks mode of `usine.yaml`, defaults applied. */
export class SettingsView extends Schema.Class<SettingsView>("@usine/orchestrator/SettingsView")({
  pollInterval: Schema.Int,
  maxChildren: Schema.Int,
  maxAttemptMinutes: Schema.NullOr(Schema.Int),
  maxAttemptTokens: Schema.NullOr(Schema.Int),
  parentModel: Schema.NullOr(ModelId),
  parentEffort: Schema.NullOr(Effort),
  operator: Schema.NullOr(OperatorLogin),
  webhooks: Schema.Literals(["off", "deliveries", "endpoint"]),
  /** The public URL of `endpoint` webhooks; null for the other modes. */
  webhooksPublicUrl: Schema.NullOr(Schema.String),
}) {}

/**
 * The instance folder the orchestrator runs, as parsed: Loops, Agents,
 * Workers, repositories with their lanes, and settings, with the files left
 * out and why, beside the runtime state of each (pauses, slots, preflights,
 * and labels as polled).
 */
export class ConfigurationView extends Schema.Class<ConfigurationView>(
  "@usine/orchestrator/ConfigurationView",
)({
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

/** One preflight check as the operator API carries it. */
export const checkView = (check: PreflightCheck): PreflightCheckView =>
  Match.valueTags(check, {
    Passed: ({ checkedAt }) => new PassedCheckView({ checkedAt: DateTime.formatIso(checkedAt) }),
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
        destination: worker.destination,
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
      }
    : { destination: null, port: null, identityFile: null, root: null, gateway: null };

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
    const [states, latestPoll, slots, preflights] = yield* Effect.all(
      [controls.states, polling.latest, workerStatus.slots, workerStatus.preflights] as const,
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
      });
    });
    const { settings, webhooks } = config;
    const configuration = new ConfigurationView({
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
 * The operator's read of the configuration: the instance folder as the
 * orchestrator parsed it, beside its runtime state. It reads only what is in
 * memory and the runtime store, never the files again.
 */
export class OperatorConfiguration extends Context.Service<
  OperatorConfiguration,
  {
    /**
     * The supplied instance's Loops, Agents, Workers, repositories, and
     * settings, with each quarantined Loop and invalid Agent and its error,
     * each Loop's pause, each Worker's slots and last preflight, and each
     * repository's labels as polling last read them. No secret is included:
     * a Gateway's admin token is named by its environment variable only.
     */
    readonly view: (
      instance: LoadedInstance,
    ) => Effect.Effect<ConfigurationView, EnginePersistenceError>;
  }
>()("@usine/orchestrator/OperatorConfiguration") {
  static readonly layer = Layer.effect(OperatorConfiguration, makeOperatorConfiguration);
}
