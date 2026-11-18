import { RegistryTag } from "@usine/config/factory";
import { InstancePath } from "@usine/config/file";
import { LoopApproval } from "@usine/config/loop";
import { Cron, Stream } from "@usine/config/trigger";
import { AgentName } from "@usine/core/agent";
import { Effort, Harness, ModelId } from "@usine/core/agent/brain";
import { GitHubLabelName } from "@usine/core/label";
import { LoopName } from "@usine/core/loop";
import { ProjectId } from "@usine/core/project";
import { RepositoryName } from "@usine/core/repository";
import { WorkerKind, WorkerName } from "@usine/core/worker";
import { type Brand, Schema } from "effect";
import {
  type ConfigurationView,
  RemovedWorkerView,
  SettingsView,
  WorkerSlotsView,
} from "./view.ts";

/** A Loop with the fields that identify it; its trigger condition and prompt are left out. */
export class LoopSummaryView extends Schema.Class<
  LoopSummaryView,
  Brand.Brand<"@usine/orchestrator/operator/configuration/summary/LoopSummaryView">
>("@usine/orchestrator/LoopSummaryView")({
  /** The project-qualified Loop name, which is its configuration identifier. */
  name: LoopName,
  /** The trigger stream: `issue`, `pr`, or `schedule`. */
  stream: Stream,
  /** The cron expression of a schedule trigger, or null for the other streams. */
  cron: Schema.NullOr(Cron),
  /** The Agent that the Loop runs. */
  agent: AgentName,
  /** Whether a Run waits for approval. */
  approval: LoopApproval,
  /** Whether the Loop is paused for new trigger submissions. */
  paused: Schema.Boolean,
}) {}

/** An Agent with its brain; its persona is left out. */
export class AgentSummaryView extends Schema.Class<
  AgentSummaryView,
  Brand.Brand<"@usine/orchestrator/operator/configuration/summary/AgentSummaryView">
>("@usine/orchestrator/AgentSummaryView")({
  /** The Agent name, which is its configuration identifier. */
  name: AgentName,
  /** The harness that runs the Agent. */
  harness: Harness,
  /** The model of the Agent's sessions. */
  model: ModelId,
  /** The reasoning effort of the Agent's sessions. */
  effort: Effort,
}) {}

/** A Worker with its kind, capacity, and slot usage; its preflight results are left out. */
export class WorkerSummaryView extends Schema.Class<
  WorkerSummaryView,
  Brand.Brand<"@usine/orchestrator/operator/configuration/summary/WorkerSummaryView">
>("@usine/orchestrator/WorkerSummaryView")({
  /** The Worker name, which is its configuration identifier. */
  name: WorkerName,
  /** The kind of Worker. */
  kind: WorkerKind,
  /** The most Attempts that the Worker runs at a time. */
  maxConcurrentAttempts: Schema.Int,
  /** Whether the Worker is paused for new Attempts. */
  paused: Schema.Boolean,
  /** The Worker's slot usage, or null if it isn't known. */
  slots: Schema.NullOr(WorkerSlotsView),
}) {}

/** A configuration file that failed to load, with the reason. */
export class FileFailureView extends Schema.Class<
  FileFailureView,
  Brand.Brand<"@usine/orchestrator/operator/configuration/summary/FileFailureView">
>("@usine/orchestrator/FileFailureView")({
  /** The name of the Loop or Agent in the file. */
  name: Schema.String,
  /** The instance-relative path of the file. */
  file: InstancePath,
  /** Why the file failed to load. */
  message: Schema.String,
}) {}

/**
 * The instance's configuration entities with the fields that identify each, without prompts,
 * personas, lanes, label states, or preflight results. Each entity's name is its identifier for
 * a configuration entity read.
 */
export class ConfigurationSummaryView extends Schema.TaggedClass<
  ConfigurationSummaryView,
  Brand.Brand<"@usine/orchestrator/operator/configuration/summary/ConfigurationSummaryView">
>("@usine/orchestrator/ConfigurationSummaryView")("ConfigurationSummary", {
  /** The projects with their member repositories. */
  projects: Schema.Array(
    Schema.Struct({
      id: ProjectId,
      name: Schema.String,
      repositories: Schema.Array(RepositoryName),
    }),
  ),
  /** The registered repositories with their tags. */
  repositories: Schema.Array(
    Schema.Struct({ name: RepositoryName, tags: Schema.Array(RegistryTag) }),
  ),
  /** The loaded Loops. */
  loops: Schema.Array(LoopSummaryView),
  /** The Loop files that failed to load. */
  quarantinedLoops: Schema.Array(FileFailureView),
  /** The loaded Agents. */
  agents: Schema.Array(AgentSummaryView),
  /** The Agent files that failed to load. */
  invalidAgents: Schema.Array(FileFailureView),
  /** The configured Workers. */
  workers: Schema.Array(WorkerSummaryView),
  /** Workers removed from configuration that still have running Attempts. */
  removedWorkers: Schema.Array(RemovedWorkerView),
  /** The names of the labels declared for creation in managed repositories. */
  labels: Schema.Array(GitHubLabelName),
  /** The number of role bindings. */
  bindings: Schema.Int,
  /** Instance settings with defaults applied and secrets omitted. */
  settings: SettingsView,
}) {}

/** Returns the summary of `view`. */
export const configurationSummary = (view: ConfigurationView): ConfigurationSummaryView =>
  ConfigurationSummaryView.make({
    projects: view.projects.map(({ id, name, repositories }) => ({ id, name, repositories })),
    repositories: view.repositories.map(({ name, tags }) => ({ name, tags })),
    loops: view.loops.map(({ name, stream, cron, agent, approval, paused }) =>
      LoopSummaryView.make({ name, stream, cron, agent, approval, paused }),
    ),
    quarantinedLoops: view.quarantinedLoops.map(({ name, file, error }) =>
      FileFailureView.make({ name, file, message: error.message }),
    ),
    agents: view.agents.map(({ name, harness, model, effort }) =>
      AgentSummaryView.make({ name, harness, model, effort }),
    ),
    invalidAgents: view.invalidAgents.map(({ name, file, error }) =>
      FileFailureView.make({ name, file, message: error.message }),
    ),
    workers: view.workers.map(({ name, kind, maxConcurrentAttempts, paused, slots }) =>
      WorkerSummaryView.make({ name, kind, maxConcurrentAttempts, paused, slots }),
    ),
    removedWorkers: view.removedWorkers,
    labels: view.labels.map(({ name }) => name),
    bindings: view.bindings.length,
    settings: view.settings,
  });
