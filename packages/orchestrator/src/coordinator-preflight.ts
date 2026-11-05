import { piGatewayModels, piGatewayPool } from "@usine/agents/pi/gateway";
import { resolveParentModel } from "@usine/core/agent";
import { ModelId } from "@usine/core/agent/brain";
import { DurableHarness } from "@usine/durable/harness";
import { WorkerCapabilityError } from "@usine/executor";
import type { SshExecutorOptions } from "@usine/executor/ssh";
import { Effect, Option } from "effect";
import { CurrentInstance } from "./current-instance/current-instance.ts";

/** Checks every configured coordinator model against each worker's gateway. */
export const coordinatorPreflight = Effect.gen(function* () {
  const durable = yield* DurableHarness;
  const current = yield* CurrentInstance;
  return Effect.fn("Orchestrator.coordinatorPreflight")(function* (worker, credentials) {
    yield* Effect.annotateCurrentSpan({ worker });
    const instance = yield* current.get;
    const available = piGatewayModels(durable.models.getModels(), credentials)[0];
    const defaultModel = Option.map(durable.defaultModel, ({ provider, modelId }) =>
      ModelId.make(`${provider}/${modelId}`),
    );
    const models = instance.agents.map((agent) =>
      Option.getOrElse(
        Option.orElse(
          resolveParentModel(agent.agent, instance.config.settings.parentModel),
          () => defaultModel,
        ),
        () =>
          ModelId.make(
            available === undefined ? "unknown/model" : `${available.provider}/${available.id}`,
          ),
      ),
    );
    for (const model of new Set(models)) {
      yield* piGatewayPool(model, credentials).pipe(
        Effect.mapError((cause) =>
          WorkerCapabilityError.make({
            worker,
            capability: "gateway",
            message: cause.message,
            cause,
          }),
        ),
      );
    }
  }) satisfies NonNullable<SshExecutorOptions["coordinatorPreflight"]>;
});
