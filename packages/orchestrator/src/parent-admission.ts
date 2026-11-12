import type { LoadedInstance } from "@usine/config/instance";
import { ConfigFileError, InstancePath } from "@usine/config/file";
import { resolveParentEffort, resolveParentModel } from "@usine/core/agent";
import type { DurableHarness } from "@usine/durable/harness";
import { resolveParent } from "@usine/durable/parent";
import { Effect, Option, Result } from "effect";

/**
 * Checks resolved coordinator brains without writing configuration or opening durable storage.
 * Agents that resolve to the same parent model and effort share one check.
 */
export const parentAdmissionProblems: (
  loaded: LoadedInstance,
  parents: Pick<DurableHarness["Service"], "models" | "defaultModel" | "credentials">,
) => Effect.Effect<Array<ConfigFileError>> = Effect.fn("Configuration.admitParents")(function* (
  loaded: LoadedInstance,
  parents: Pick<DurableHarness["Service"], "models" | "defaultModel" | "credentials">,
) {
  const keyed = loaded.agents.map(({ name, agent }) => {
    const spec = {
      parentModel: resolveParentModel(agent, loaded.config.settings.parentModel),
      parentEffort: resolveParentEffort(agent, loaded.config.settings.parentEffort),
    };
    return {
      name,
      spec,
      key: `${spec.parentEffort} ${Option.getOrElse(spec.parentModel, () => "")}`,
    };
  });
  const results = new Map<string, Option.Option<string>>();
  for (const { spec, key } of keyed) {
    if (results.has(key)) continue;
    const admitted = yield* resolveParent(parents, spec, Option.none()).pipe(
      Effect.result,
      Effect.withSpan("Configuration.admitParent", {
        attributes: { agents: keyed.filter((entry) => entry.key === key).map(({ name }) => name) },
      }),
    );
    results.set(
      key,
      Result.isFailure(admitted) ? Option.some(admitted.failure.message) : Option.none(),
    );
  }
  const problems: Array<ConfigFileError> = [];
  for (const { name, key } of keyed) {
    const refusal = results.get(key) ?? Option.none();
    if (Option.isNone(refusal)) continue;
    const problem = ConfigFileError.make({
      file: InstancePath.make(`agents/${name}.md`),
      stage: "schema",
      expression: Option.none(),
      message: `Agent "${name}" cannot run as coordinator: ${refusal.value}`,
    });
    problems.push(problem);
    yield* Effect.logWarning("Coordinator brain refused for configuration", {
      agent: name,
      role: "coordinator",
      message: problem.message,
    });
  }
  yield* Effect.logInfo("Coordinator brain validation completed", {
    count: loaded.agents.length,
    checked: results.size,
    refused: problems.length,
  });
  return problems;
});
