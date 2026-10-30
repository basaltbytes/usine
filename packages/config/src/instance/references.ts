import { AgentName } from "@usine/core/agent";
import { canonicalRepositoryName } from "@usine/core/repository";
import { Option } from "effect";
import { InstancePath, ConfigFileError } from "../file.ts";
import { RegistryTag, UsineConfig } from "../factory.ts";
import { LoopFile } from "../loop.ts";
import type { AgentFile } from "../agent.ts";

/** The names a loop can reference in a loaded instance. */
export interface ReferenceIndex {
  /** The names of valid agents available to loops. */
  readonly agentNames: ReadonlySet<AgentName>;
  /** The tags declared by at least one registered repository. */
  readonly registryTags: ReadonlySet<RegistryTag>;
  /** The registry repository names, canonicalized with `canonicalRepositoryName`. */
  readonly repoNames: ReadonlySet<string>;
}

/**
 * Builds the agent names, registry tags, and canonical repository names that draft reference
 * checks accept, from `config` and the loaded `agents`.
 */
export const referenceIndex = (
  config: UsineConfig,
  agents: ReadonlyArray<AgentFile>,
): ReferenceIndex => ({
  agentNames: new Set(agents.map(({ name }) => name)),
  registryTags: new Set(config.repos.flatMap(({ tags }) => tags)),
  repoNames: new Set(config.repos.map(({ name }) => canonicalRepositoryName(name))),
});

const quoted = (names: ReadonlyArray<string>): string =>
  names.map((name) => `"${name}"`).join(", ");

/**
 * Returns the error for a loop that references an agent or selector entry the instance doesn't
 * have, or `None` if every reference resolves.
 */
export const loopReferenceFailure = (
  file: InstancePath,
  loop: { readonly agent: AgentName | undefined; readonly selector: LoopFile["selector"] },
  references: ReferenceIndex,
): Option.Option<ConfigFileError> => {
  const problems: Array<{ readonly path: ReadonlyArray<string>; readonly message: string }> = [];
  const failure = (): Option.Option<ConfigFileError> =>
    problems.length === 0
      ? Option.none()
      : Option.some(
          new ConfigFileError({
            file,
            stage: "reference",
            expression: Option.none(),
            message: problems.map(({ message }) => message).join("\n"),
            details: problems,
          }),
        );
  if (loop.agent !== undefined && !references.agentNames.has(loop.agent)) {
    problems.push({
      path: ["agent"],
      message: `Unknown agent "${loop.agent}": agents/${loop.agent}.md is missing or invalid. Fix the agent file, or set agent to an existing agent.`,
    });
  }

  if (Option.isNone(loop.selector)) return failure();
  if (Option.isSome(loop.selector.value.repos)) {
    const missing = loop.selector.value.repos.value.filter(
      (name) => !references.repoNames.has(canonicalRepositoryName(name)),
    );
    if (missing.length > 0) {
      problems.push({
        path: ["selector", "repos"],
        message: `Unknown repositories in selector.repos: ${quoted(missing)}. Add them under repos in usine.yaml.`,
      });
    }
  }

  if (Option.isSome(loop.selector.value.tags)) {
    const missing = loop.selector.value.tags.value.filter(
      (tag) => !references.registryTags.has(tag),
    );
    if (missing.length > 0) {
      problems.push({
        path: ["selector", "tags"],
        message: `Unknown tags in selector.tags: ${quoted(missing)}. Add them to a repository's tags in usine.yaml.`,
      });
    }
  }
  return failure();
};
