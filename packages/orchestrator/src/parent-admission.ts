import type { LoadedInstance } from "@usine/config/instance";
import { ConfigFileError, InstancePath } from "@usine/config/file";
import { resolveParentEffort, resolveParentModel } from "@usine/core/agent";
import type { DurableHarness } from "@usine/durable/harness";
import { resolveParent } from "@usine/durable/parent";
import { Effect, Option, Result } from "effect";

/** Checks resolved coordinator brains without writing configuration or opening durable storage. */
export const parentAdmissionProblems: (
  loaded: LoadedInstance,
  parents: Pick<DurableHarness["Service"], "models" | "defaultModel" | "credentials">,
) => Effect.Effect<Array<ConfigFileError>> = Effect.fn("Configuration.admitParents")(function* (
  loaded: LoadedInstance,
  parents: Pick<DurableHarness["Service"], "models" | "defaultModel" | "credentials">,
) {
  const problems: Array<ConfigFileError> = [];
  for (const { name, agent } of loaded.agents) {
    const admitted = yield* resolveParent(
      parents,
      {
        parentModel: resolveParentModel(agent, loaded.config.settings.parentModel),
        parentEffort: resolveParentEffort(agent, loaded.config.settings.parentEffort),
      },
      Option.none(),
    ).pipe(
      Effect.result,
      Effect.withSpan("Configuration.admitParent", { attributes: { agent: name } }),
    );
    if (Result.isFailure(admitted)) {
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
  }
  yield* Effect.logInfo("Coordinator brain validation completed", {
    count: loaded.agents.length,
    refused: problems.length,
  });
  return problems;
});
