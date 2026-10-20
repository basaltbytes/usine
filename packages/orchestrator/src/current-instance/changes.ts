import { type AgentFile, InvalidAgent } from "@usine/config/agent";
import type { Worker as ConfigWorker } from "@usine/config/factory";
import type { LoadedInstance } from "@usine/config/instance";
import { canonicalLabelName, GitHubLabelName } from "@usine/config/label";
import { QuarantinedLoop } from "@usine/config/loop";
import { AgentName } from "@usine/core/agent";
import { LoopName } from "@usine/core/loop";
import { canonicalRepositoryName, RepositoryName } from "@usine/core/repository";
import { WorkerName } from "@usine/core/worker";
import { Equal, Schema } from "effect";

const RESTART_BLOCKS = ["workers", "webhooks"] as const;

/** A `usine.yaml` block in which some changes apply only when `usine up` starts, so a reload refuses them. */
export const RestartBlock = Schema.Literals(RESTART_BLOCKS);

export type RestartBlock = typeof RestartBlock.Type;

/** A change to `usine.yaml` that only a restart of `usine up` applies. */
export interface RestartChange {
  readonly block: RestartBlock;
  /** The changed field as a path into `usine.yaml`, such as `webhooks` or `workers.build-1.destination`. */
  readonly field: string;
  /** What changed, for operators, as a clause such as `the webhooks block changed`. */
  readonly reason: string;
}

const nameChanges = <S extends Schema.Top>(name: S) =>
  Schema.Struct({
    added: Schema.Array(name),
    removed: Schema.Array(name),
    changed: Schema.Array(name),
  });

/**
 * What an accepted reload changed compared with the running instance: Loops,
 * Agents, declared labels, registered repositories, and Workers by name, and
 * whether `settings` or the `operator` login changed. A changed Worker has a
 * new `max_concurrent_attempts`. It also lists every Loop and Agent file the
 * reloaded folder left out, which Needs you shows until the file loads.
 */
export class InstanceReload extends Schema.Class<InstanceReload>(
  "@usine/orchestrator/InstanceReload",
)({
  loops: nameChanges(LoopName),
  agents: nameChanges(AgentName),
  labels: nameChanges(GitHubLabelName),
  repos: nameChanges(RepositoryName),
  workers: nameChanges(WorkerName),
  settingsChanged: Schema.Boolean,
  operatorChanged: Schema.Boolean,
  quarantinedLoops: Schema.Array(QuarantinedLoop),
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

/** Compares a freshly loaded instance folder with the running instance. */
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

/** The Agents of `loaded` whose brain no Agent of the running instance has. */
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
 * The changes `loaded` makes that only a restart applies: a changed `webhooks`
 * block, and a changed `workers` block while no Worker runs Attempts, as in
 * setup mode. While Workers run, `workersChange` sorts the `workers` changes.
 */
export const restartChanges = (
  running: LoadedInstance,
  loaded: LoadedInstance,
  workersRun: boolean,
): ReadonlyArray<RestartChange> => [
  ...(Equal.equals(running.config.webhooks, loaded.config.webhooks)
    ? []
    : [{ block: "webhooks", field: "webhooks", reason: "the webhooks block changed" } as const]),
  ...(workersRun || Equal.equals(running.config.workers, loaded.config.workers)
    ? []
    : [
        {
          block: "workers",
          field: "workers",
          reason: "the workers block changed while no Worker runs",
        } as const,
      ]),
];

const yamlKey = (field: string): string =>
  field.replace(/[A-Z]/gu, (letter) => `_${letter.toLowerCase()}`);

/**
 * The `usine.yaml` keys of a Worker entry, other than `name` and
 * `max_concurrent_attempts`, whose value differs between `before` and
 * `after`; only `kind` when the kind differs.
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
  return [...new Set([...previous.keys(), ...next.keys()])]
    .filter((key) => !Equal.equals(previous.get(key), next.get(key)))
    .map(yamlKey);
};

/** A Worker that a reload keeps with a new `max_concurrent_attempts`. */
interface ResizedWorker {
  /** The Worker's reloaded entry. */
  readonly worker: ConfigWorker;
  /** Its `max_concurrent_attempts` in the running instance. */
  readonly from: number;
}

/** How a reload changes the `workers` block, by Worker name. */
export interface WorkersChange {
  readonly resized: ReadonlyArray<ResizedWorker>;
  readonly added: ReadonlyArray<ConfigWorker>;
  readonly removed: ReadonlyArray<ConfigWorker>;
  /**
   * The changes the running Workers cannot take: a Worker that keeps its name
   * but changes its kind or a setting other than `max_concurrent_attempts`,
   * and a renamed Worker, which is a removed and an added Worker with the same
   * kind and settings.
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
  for (const worker of loaded) {
    const previous = before.get(worker.name);
    if (previous === undefined) continue;
    const changed = changedWorkerSettings(previous, worker);
    for (const key of changed) {
      restart.push({
        block: "workers",
        field: `workers.${worker.name}.${key}`,
        reason:
          key === "kind"
            ? `Worker ${worker.name} changed its kind from ${previous.kind} to ${worker.kind}`
            : `Worker ${worker.name} changed its ${key}`,
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
      reason: `Worker ${previous.name} is renamed to ${renamed.name}`,
    });
  }
  return { resized, added, removed, restart };
};
