import { type AgentFile, InvalidAgent } from "@usine/config/agent";
import type { LoadedInstance } from "@usine/config/instance";
import { canonicalLabelName, GitHubLabelName } from "@usine/config/label";
import { QuarantinedLoop } from "@usine/config/loop";
import { AgentName } from "@usine/core/agent";
import { LoopName } from "@usine/core/loop";
import { canonicalRepositoryName, RepositoryName } from "@usine/core/repository";
import { Equal, Schema } from "effect";

const RESTART_BLOCKS = ["workers", "webhooks"] as const;

/** A `usine.yaml` block that applies only when `usine up` starts, so a reload refuses to change it. */
export const RestartBlock = Schema.Literals(RESTART_BLOCKS);

export type RestartBlock = typeof RestartBlock.Type;

const nameChanges = <S extends Schema.Top>(name: S) =>
  Schema.Struct({
    added: Schema.Array(name),
    removed: Schema.Array(name),
    changed: Schema.Array(name),
  });

/**
 * What an accepted reload changed compared with the running instance: Loops,
 * Agents, declared labels, and registered repositories by name, and whether
 * `settings` or the `operator` login changed. It also lists every Loop and
 * Agent file the reloaded folder left out, which Needs you shows until the
 * file loads.
 */
export class InstanceReload extends Schema.Class<InstanceReload>(
  "@usine/orchestrator/InstanceReload",
)({
  loops: nameChanges(LoopName),
  agents: nameChanges(AgentName),
  labels: nameChanges(GitHubLabelName),
  repos: nameChanges(RepositoryName),
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

/** The restart-only blocks whose value in `loaded` differs from the running instance. */
export const changedRestartBlocks = (
  running: LoadedInstance,
  loaded: LoadedInstance,
): ReadonlyArray<RestartBlock> =>
  RESTART_BLOCKS.filter((block) => !Equal.equals(running.config[block], loaded.config[block]));
