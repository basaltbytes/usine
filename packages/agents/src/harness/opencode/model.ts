import { type BrainSpec, Harness } from "@usine/core/agent/brain";
import type { ModelProvider } from "@usine/core/agent/provider";
import { Array as Arr, Effect, Option } from "effect";
import { UnknownModelError, UnsupportedEffortError } from "../../runtime.ts";
import { type OpenCodeApi, query } from "./api.ts";
import { Models } from "./codec.ts";
import { effortVariant } from "./config.ts";
import { opencode } from "./descriptor.ts";

/** The provider of a session's model, and the model's ID in that provider's list. */
export interface ModelChoice {
  readonly provider: ModelProvider;
  /** The model ID without the provider, such as `gpt-5.4-mini`. */
  readonly model: string;
}

/**
 * Returns the provider and model that `brain` selects in OpenCode's `provider/model` notation, such
 * as `opencode-go/glm-5.3`: the provider whose ID comes before the first `/`, or the descriptor's
 * first provider for an ID without one. Fails for a provider that the descriptor doesn't list, and
 * for an empty model ID after the provider.
 */
export const modelChoice = Effect.fn("OpenCode.modelChoice")(function* (brain: BrainSpec) {
  const separator = brain.model.indexOf("/");
  const prefix =
    separator === -1 ? Option.none<string>() : Option.some(brain.model.slice(0, separator));
  const model = brain.model.slice(separator + 1);
  const provider = Option.match(prefix, {
    onNone: () => Arr.head(opencode.providers),
    onSome: (id) => Arr.findFirst(opencode.providers, (listed) => listed.id === id),
  });
  if (Option.isSome(provider) && model.trim() !== "")
    return { provider: provider.value, model } satisfies ModelChoice;
  const listed = opencode.providers.map(({ id }) => id);
  yield* Effect.logError("OpenCode can't select a provider for the model", {
    model: brain.model,
    providers: listed.join(","),
  });
  return yield* UnknownModelError.make({
    harness: opencode.id,
    model: brain.model,
    message: Option.isSome(provider)
      ? `The model "${brain.model}" names no model after its provider`
      : `OpenCode has no provider "${Option.getOrElse(prefix, () => "")}" for the model "${brain.model}". Choose one of ${listed.join(", ")} as <provider>/<model>; a model ID without a provider is ${listed[0] ?? "none"}'s.`,
  });
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
