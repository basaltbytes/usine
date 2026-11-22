import { type BrainSpec, Harness } from "@usine/core/agent/brain";
import { Effect, Option } from "effect";
import { UnknownModelError, UnsupportedEffortError } from "../../runtime.ts";
import { type OpenCodeApi, query } from "./api.ts";
import { Models } from "./codec.ts";
import { effortVariant, PROVIDER } from "./config.ts";

/**
 * Checks `brain` against the models that OpenCode lists for directory `cwd`, or for its own
 * directory without one, which needs no provider request. Returns the session's model with the reasoning variant for its effort, and
 * fails for a model that OpenCode doesn't list or turned off, or an effort that it has no variant
 * for.
 */
export const checkModel = Effect.fn("OpenCode.checkModel")(function* (
  api: OpenCodeApi,
  brain: BrainSpec,
  cwd: Option.Option<string>,
) {
  yield* Effect.annotateCurrentSpan({ model: brain.model, effort: brain.effort });
  const { data } = yield* api.read(
    Models,
    "launch",
    "GET",
    Option.match(cwd, {
      onNone: () => "/api/model",
      onSome: (directory) => `/api/model?${query("location[directory]", directory)}`,
    }),
  );
  const model = data.find(({ providerID, id }) => providerID === PROVIDER && id === brain.model);
  if (model === undefined || !model.enabled) {
    yield* Effect.logError("OpenCode has no model for the brain", {
      model: brain.model,
      listed: model !== undefined,
    });
    return yield* UnknownModelError.make({
      harness: Harness.make("opencode"),
      model: brain.model,
      message: `OpenCode has no ${model === undefined ? "" : "enabled "}model "${brain.model}" for the ${PROVIDER} provider`,
    });
  }
  const variant = effortVariant(brain.effort);
  if (!model.variants.some(({ id }) => id === variant)) {
    yield* Effect.logError("OpenCode has no variant for the brain's effort", {
      model: brain.model,
      effort: brain.effort,
      variants: model.variants.map(({ id }) => id).join(","),
    });
    return yield* UnsupportedEffortError.make({
      harness: Harness.make("opencode"),
      model: brain.model,
      effort: brain.effort,
      message: `OpenCode model "${brain.model}" has no variant for effort ${brain.effort}; it offers ${model.variants.map(({ id }) => id).join(", ") || "none"}`,
    });
  }
  return { providerID: PROVIDER, id: brain.model, variant };
});
