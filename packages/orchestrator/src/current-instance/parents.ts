import type { LoadedInstance } from "@usine/config/instance";
import { FactoryConfigError, InstancePath } from "@usine/config/file";
import { resolveParentEffort, resolveParentModel } from "@usine/core/agent";
import { DurableHarness } from "@usine/durable/harness";
import { resolveParent } from "@usine/durable/parent";
import { Effect, Layer } from "effect";
import { CurrentInstance } from "./current-instance.ts";

/** Admits every resolved coordinator brain before storing or applying configuration revisions. */
export const parentAdmissionLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const harness = yield* DurableHarness;
    const instances = yield* CurrentInstance;
    yield* instances.registerParentAdmission(
      Effect.fn("CurrentInstance.admitParents")(function* (loaded: LoadedInstance) {
        for (const { name, agent } of loaded.agents) {
          yield* resolveParent(harness.models, harness.defaultModel, {
            parentModel: resolveParentModel(agent, loaded.config.settings.parentModel),
            parentEffort: resolveParentEffort(agent, loaded.config.settings.parentEffort),
          }).pipe(
            Effect.mapError((cause) =>
              FactoryConfigError.make({
                file: InstancePath.make(`agents/${name}.md`),
                stage: "schema",
                message: `Agent "${name}" cannot run as coordinator: ${cause.message}. The running configuration is unchanged.`,
              }),
            ),
            Effect.withSpan("CurrentInstance.admitParent", { attributes: { agent: name } }),
          );
        }
        yield* Effect.logInfo("Coordinator brains admitted for configuration revision", {
          count: loaded.agents.length,
        });
      }),
    );
  }),
);
