import { type BrainSpec, Harness } from "@usine/core/agent/brain";
import { Effect, Option } from "effect";
import { UnknownModelError, UnsupportedEffortError } from "../../runtime.ts";
import type { ModelChoice } from "../harness.ts";
import { type OpenCodeApi, query } from "./api.ts";
import { Models } from "./codec.ts";
import { effortVariant } from "./config.ts";
import { opencode } from "./descriptor.ts";

/**
 * Returns the provider and model that `brain` selects in OpenCode's `provider/model` notation, such
 * as `opencode-go/glm-5.3`, from the descriptor. Fails for a provider that the descriptor doesn't
 * list, and for an empty model ID after the provider.
 */
export const modelChoice = Effect.fn("OpenCode.modelChoice")(function* (brain: BrainSpec) {
  yield* Effect.annotateCurrentSpan({ model: brain.model });
  return yield* Effect.fromResult(opencode.providerOf(brain.model)).pipe(
    Effect.tapError(() =>
      Effect.logError("OpenCode can't select a provider for the model", {
        model: brain.model,
        providers: opencode.providers.map(({ id }) => id).join(","),
      }),
    ),
  );
});

/**
 * Checks `brain` against the models that OpenCode lists for `choice`'s provider in directory `cwd`,
 * or in its own directory without one, which needs no provider request. Returns the session's
 * model with the reasoning variant for its effort, and fails for a model that OpenCode doesn't
 * list or turned off, or an effort that it has no variant for.
 */
export const checkModel = Effect.fn("OpenCode.checkModel")(function* (
  api: OpenCodeApi,
  brain: BrainSpec,
  choice: ModelChoice,
  cwd: Option.Option<string>,
) {
  const provider = choice.provider.id;
  yield* Effect.annotateCurrentSpan({ model: brain.model, effort: brain.effort, provider });
  const { data } = yield* api.read(
    Models,
    "launch",
    "GET",
    Option.match(cwd, {
      onNone: () => "/api/model",
      onSome: (directory) => `/api/model?${query("location[directory]", directory)}`,
    }),
  );
  const model = data.find(({ providerID, id }) => providerID === provider && id === choice.model);
  if (model === undefined || !model.enabled) {
    yield* Effect.logError("OpenCode has no model for the brain", {
      model: brain.model,
      provider,
      listed: model !== undefined,
    });
    return yield* UnknownModelError.make({
      harness: Harness.make("opencode"),
      model: brain.model,
      message: `OpenCode has no ${model === undefined ? "" : "enabled "}model "${choice.model}" for the ${provider} provider`,
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
  return { providerID: provider, id: choice.model, variant };
});
