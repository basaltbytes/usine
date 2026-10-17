import { AgentName } from "@usine/core/agent";
import { canonicalRepositoryName } from "@usine/core/repository";
import { Option } from "effect";
import { InstancePath, ConfigFileError } from "../file.ts";
import { RegistryTag, UsineConfig } from "../factory.ts";
import { LoopFile } from "../loop.ts";
import type { AgentFile } from "../agent.ts";

/** The agent and selector names a loop may reference in one loaded instance. */
export interface ReferenceIndex {
  readonly agentNames: ReadonlySet<AgentName>;
  readonly registryTags: ReadonlySet<RegistryTag>;
  /** Registry repository names through `canonicalRepositoryName`, since GitHub ignores case. */
  readonly repoNames: ReadonlySet<string>;
}

export const referenceIndex = (
  config: UsineConfig,
  agents: ReadonlyArray<AgentFile>,
): ReferenceIndex => ({
  agentNames: new Set(agents.map(({ name }) => name)),
  registryTags: new Set(config.repos.flatMap(({ tags }) => tags)),
  repoNames: new Set(config.repos.map(({ name }) => canonicalRepositoryName(name))),
});

/**
 * Returns the reference error that quarantines this loop, if it names an agent
 * or selector entry the instance does not have. The folder loader reports it
 * per file and LoadedInstance refuses to construct with it.
 */
export const loopReferenceFailure = (
  file: InstancePath,
  loop: LoopFile,
  references: ReferenceIndex,
): Option.Option<ConfigFileError> => {
  const referenceError = (message: string): Option.Option<ConfigFileError> =>
    Option.some(
      new ConfigFileError({ file, stage: "reference", expression: Option.none(), message }),
    );
  if (!references.agentNames.has(loop.agent)) {
    return referenceError(`Unknown agent: ${loop.agent}`);
  }

  if (Option.isNone(loop.selector)) return Option.none();
  if (Option.isSome(loop.selector.value.repos)) {
    const missing = loop.selector.value.repos.value.filter(
      (name) => !references.repoNames.has(canonicalRepositoryName(name)),
    );
    if (missing.length > 0) {
      return referenceError(`Unknown selector repos: ${missing.join(", ")}`);
    }
  }

  if (Option.isSome(loop.selector.value.tags)) {
    const missing = loop.selector.value.tags.value.filter(
      (tag) => !references.registryTags.has(tag),
    );
    if (missing.length > 0) {
      return referenceError(`Unknown selector tags: ${missing.join(", ")}`);
    }
  }
  return Option.none();
};
