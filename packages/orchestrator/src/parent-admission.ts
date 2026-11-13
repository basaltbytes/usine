import type { LoadedInstance } from "@usine/config/instance";
import { ConfigFileError, InstancePath } from "@usine/config/file";
import { resolveCoordinator, resolveParentEffort, resolveParentModel } from "@usine/core/agent";
import type { DurableHarness } from "@usine/durable/harness";
import { resolveParent, sharedParentLogin } from "@usine/durable/parent";
import { Effect, Option, Result } from "effect";

/**
 * Checks resolved coordinator brains without writing configuration or opening durable storage.
 * Looks up each agent's parent model and effort in the catalog, and asks the credential's login
 * once per provider. Agents that resolve to `coordinator: events` run no parent session and need no
 * check.
 */
export const parentAdmissionProblems: (
  loaded: LoadedInstance,
  parents: Pick<DurableHarness["Service"], "models" | "defaultModel" | "credentials">,
) => Effect.Effect<Array<ConfigFileError>> = Effect.fn("Configuration.admitParents")(function* (
  loaded: LoadedInstance,
  parents: Pick<DurableHarness["Service"], "models" | "defaultModel" | "credentials">,
) {
  const { settings } = loaded.config;
  const parented = loaded.agents.filter(
    ({ agent }) => resolveCoordinator(agent, settings.coordinator) === "session",
  );
  const login = sharedParentLogin(parents);
  const problems: Array<ConfigFileError> = [];
  for (const { name, agent } of parented) {
    const admitted = yield* resolveParent(
      parents,
      {
        parentModel: resolveParentModel(agent, settings.parentModel),
        parentEffort: resolveParentEffort(agent, settings.parentEffort),
      },
      Option.none(),
      login,
    ).pipe(
      Effect.result,
      Effect.withSpan("Configuration.admitParent", { attributes: { agent: name } }),
    );
    if (Result.isSuccess(admitted)) continue;
    const problem = ConfigFileError.make({
      file: InstancePath.make(`agents/${name}.md`),
      stage: "schema",
      expression: Option.none(),
      message: `Agent "${name}" cannot run as coordinator: ${admitted.failure.message}`,
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
    skipped: loaded.agents.length - parented.length,
    checked: parented.length,
    refused: problems.length,
  });
  return problems;
});
