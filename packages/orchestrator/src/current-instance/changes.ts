import { type AgentFile, InvalidAgent } from "@usine/config/agent";
import type { Worker as ConfigWorker } from "@usine/config/factory";
import type { LoadedInstance } from "@usine/config/instance";
import { canonicalLabelName, GitHubLabelName } from "@usine/config/label";
import { QuarantinedLoop } from "@usine/config/loop";
import { AgentName } from "@usine/core/agent";
import { ProjectId } from "@usine/core/project";
import { LoopName } from "@usine/core/loop";
import { canonicalRepositoryName, RepositoryName } from "@usine/core/repository";
import { WorkerName } from "@usine/core/worker";
import { Equal, Schema } from "effect";

const RESTART_BLOCKS = ["workers", "tracing"] as const;

/**
 * A `usine.yaml` block with changes that apply only when `usine up` starts, so a reload refuses
 * them.
 */
export const RestartBlock = Schema.Literals(RESTART_BLOCKS);

/**
 * A `usine.yaml` block with changes that apply only when `usine up` starts, so a reload refuses
 * them.
 */
export type RestartBlock = typeof RestartBlock.Type;

/** A change to `usine.yaml` that only a restart of `usine up` applies. */
export interface RestartChange {
  readonly block: RestartBlock;
  /** The changed field as a path into `usine.yaml`, such as `tracing` or `workers.build-1.kind`. */
  readonly field: string;
  /** An operator-facing clause, such as `the tracing block changed`. */
  readonly reason: string;
}

const nameChanges = <S extends Schema.Top>(name: S) =>
  Schema.Struct({
    added: Schema.Array(name),
    removed: Schema.Array(name),
    changed: Schema.Array(name),
  });

/**
 * The changes of an accepted reload by name, whether `settings` or the `operator` login changed,
 * and the Loop and Agent files that were left out.
 */
export class InstanceReload extends Schema.Class<InstanceReload>(
  "@usine/orchestrator/InstanceReload",
)({
  /** The loop names added, removed, or changed by the accepted reload. */
  loops: nameChanges(LoopName),
  /** The agent names added, removed, or changed by the accepted reload. */
  agents: nameChanges(AgentName),
  /** The label names added, removed, or changed by the accepted reload. */
  labels: nameChanges(GitHubLabelName),
  /** The repository names added, removed, or changed by the accepted reload. */
  repos: nameChanges(RepositoryName),
  /** The project IDs added, removed, or changed by the accepted reload. */
  projects: nameChanges(ProjectId),
  /** The worker names added, removed, or changed by the accepted reload. */
  workers: nameChanges(WorkerName),
  /** Whether instance settings changed. */
  settingsChanged: Schema.Boolean,
  /** Whether the configured operator login changed. */
  operatorChanged: Schema.Boolean,
  /** Loop files excluded from the loaded instance, with their validation errors. */
  quarantinedLoops: Schema.Array(QuarantinedLoop),
  /** Agent files excluded from the loaded roster, with their validation errors. */
  invalidAgents: Schema.Array(InvalidAgent),
}) {}

interface NameChanges<N> {
  readonly added: ReadonlyArray<N>;
  readonly removed: ReadonlyArray<N>;
  readonly changed: ReadonlyArray<N>;
}

const changesBy = <A, N>(
  running: ReadonlyArray<A>,
  loaded: ReadonlyArray<A>,
  name: (value: A) => N,
  key: (value: A) => string,
): NameChanges<N> => {
  const before = new Map(running.map((value) => [key(value), value]));
  const after = new Set(loaded.map(key));
  return {
    added: loaded.filter((value) => !before.has(key(value))).map(name),
    removed: running.filter((value) => !after.has(key(value))).map(name),
    changed: loaded
      .filter((value) => {
        const previous = before.get(key(value));
        return previous !== undefined && !Equal.equals(previous, value);
      })
      .map(name),
  };
};

/** Compares a newly loaded instance folder with the running instance. */
export const instanceReload = (running: LoadedInstance, loaded: LoadedInstance): InstanceReload =>
  new InstanceReload({
    loops: changesBy(
      running.loops,
      loaded.loops,
      ({ name }) => name,
      ({ name }) => name,
    ),
    agents: changesBy(
      running.agents,
      loaded.agents,
      ({ name }) => name,
      ({ name }) => name,
    ),
    labels: changesBy(
      running.config.labels,
      loaded.config.labels,
      ({ name }) => name,
      ({ name }) => canonicalLabelName(name),
    ),
    projects: changesBy(
      running.config.projects,
      loaded.config.projects,
      ({ id }) => id,
      ({ id }) => id,
    ),
    repos: changesBy(
      running.config.repos,
      loaded.config.repos,
      ({ name }) => name,
      ({ name }) => canonicalRepositoryName(name),
    ),
    workers: changesBy(
      running.config.workers,
      loaded.config.workers,
      ({ name }) => name,
      ({ name }) => name,
    ),
    settingsChanged: !Equal.equals(running.config.settings, loaded.config.settings),
    operatorChanged: !Equal.equals(running.config.operator, loaded.config.operator),
    quarantinedLoops: loaded.quarantinedLoops,
    invalidAgents: loaded.invalidAgents,
  });

/** Returns the Agents of `loaded` whose brain no running Agent has. */
export const agentsWithNewBrains = (
  running: LoadedInstance,
  loaded: LoadedInstance,
): ReadonlyArray<AgentFile> => {
  const runningBrains = running.agents.map(({ agent }) => agent.brain);
  return loaded.agents.filter(
    ({ agent }) => !runningBrains.some((brain) => Equal.equals(brain, agent.brain)),
  );
};

/**
 * Returns the changes in `loaded` that only a restart applies: a changed `tracing`
 * block, and a changed `workers` block while no Worker runs Attempts, as in setup mode.
 */
export const restartChanges = (
  running: LoadedInstance,
  loaded: LoadedInstance,
  workersRun: boolean,
): ReadonlyArray<RestartChange> => [
  ...(Equal.equals(running.config.tracing, loaded.config.tracing)
    ? []
    : [{ block: "tracing", field: "tracing", reason: "the tracing block changed" } as const]),
  ...(workersRun || Equal.equals(running.config.workers, loaded.config.workers)
    ? []
    : [
        {
          block: "workers",
          field: "workers",
          reason: "the workers block changed while no worker is running",
        } as const,
      ]),
];

/**
 * Returns the keys of a Worker entry, other than `name` and `max_concurrent_attempts`, that differ
 * between `before` and `after`. Returns only `kind` if the kind differs.
 */
const changedWorkerSettings = (
  before: ConfigWorker,
  after: ConfigWorker,
): ReadonlyArray<string> => {
  if (before.kind !== after.kind) return ["kind"];
  const settings = (worker: ConfigWorker) =>
    new Map(
      Object.entries(worker).filter(([key]) => key !== "name" && key !== "maxConcurrentAttempts"),
    );
  const previous = settings(before);
  const next = settings(after);
  return [...new Set([...previous.keys(), ...next.keys()])].filter(
    (key) => !Equal.equals(previous.get(key), next.get(key)),
  );
};

/** A Worker that a reload keeps with a new `max_concurrent_attempts`. */
interface ResizedWorker {
  readonly worker: ConfigWorker;
  /** The `max_concurrent_attempts` in the running instance. */
  readonly from: number;
}

/** The changes a reload makes to the `workers` block, by Worker name. */
export interface WorkersChange {
  readonly resized: ReadonlyArray<ResizedWorker>;
  readonly updated: ReadonlyArray<ConfigWorker>;
  readonly added: ReadonlyArray<ConfigWorker>;
  readonly removed: ReadonlyArray<ConfigWorker>;
  /**
   * A changed kind or a rename, which counts as a removal plus an addition with the same settings.
   */
  readonly restart: ReadonlyArray<RestartChange>;
}

/** Compares the reloaded `workers` block with the running one. */
export const workersChange = (
  running: ReadonlyArray<ConfigWorker>,
  loaded: ReadonlyArray<ConfigWorker>,
): WorkersChange => {
  const before = new Map(running.map((worker) => [worker.name, worker]));
  const after = new Set(loaded.map(({ name }) => name));
  const restart: Array<RestartChange> = [];
  const resized: Array<ResizedWorker> = [];
  const updated: Array<ConfigWorker> = [];
  for (const worker of loaded) {
    const previous = before.get(worker.name);
    if (previous === undefined) continue;
    const changed = changedWorkerSettings(previous, worker);
    if (previous.kind === worker.kind && changed.length > 0) updated.push(worker);
    if (previous.kind !== worker.kind) {
      restart.push({
        block: "workers",
        field: `workers.${worker.name}.kind`,
        reason: `worker "${worker.name}" changed kind from ${previous.kind} to ${worker.kind}`,
      });
    }
    if (changed.length === 0 && previous.maxConcurrentAttempts !== worker.maxConcurrentAttempts) {
      resized.push({ worker, from: previous.maxConcurrentAttempts });
    }
  }
  const added = loaded.filter(({ name }) => !before.has(name));
  const removed = running.filter(({ name }) => !after.has(name));
  for (const previous of removed) {
    const renamed = added.find((worker) => changedWorkerSettings(previous, worker).length === 0);
    if (renamed === undefined) continue;
    restart.push({
      block: "workers",
      field: `workers.${previous.name}.name`,
      reason: `worker "${previous.name}" was renamed to "${renamed.name}"`,
    });
  }
  return { resized, updated, added, removed, restart };
};
