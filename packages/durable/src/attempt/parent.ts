import { getSupportedThinkingLevels, type Models } from "@earendil-works/pi-ai";
import type { ModelRef } from "@earendil-works/pi-durable";
import {
  PoolUnavailableError,
  SessionOperationError,
  UnknownModelError,
  UnsupportedEffortError,
} from "@usine/agents/runtime";
import { BrainSpec, ModelId } from "@usine/core/agent/brain";
import { AgentSessionId, type BillingPool, ParentSession } from "@usine/core/agent/session";
import type { AttemptId } from "@usine/core/attempt";
import type { RunSpec } from "@usine/core/attempt/channel";
import { Effect, Option } from "effect";

type PiPool = Extract<BillingPool, "apiKeys" | "chatgptPlan">;

/** The model the Attempt's Pi parent runs with, checked against its effort and credential before the conversation exists. */
interface ResolvedParent {
  readonly ref: ModelRef;
  readonly model: ModelId;
  readonly pool: PiPool;
}

/** usine's id for the Attempt's Pi parent, the default target of operator input. */
export const parentSessionId = (attemptId: AttemptId): AgentSessionId =>
  AgentSessionId.make(`parent:${attemptId}`);

/** The parent as session events record it: the rostered Agent with the model actually resolved. */
export const parentSession = (spec: RunSpec, model: ModelId): ParentSession =>
  new ParentSession({
    id: parentSessionId(spec.attemptId),
    agent: spec.agent.name,
    brain: new BrainSpec({ harness: "pi", model, effort: spec.parentEffort }),
  });

const splitModel = (model: ModelId): Option.Option<ModelRef> => {
  const separator = model.indexOf("/");
  return separator <= 0 || separator === model.length - 1
    ? Option.none()
    : Option.some({ provider: model.slice(0, separator), modelId: model.slice(separator + 1) });
};

/** The billing pool the chosen provider spends from, checked before the parent starts (ADR 0021). */
const requiredPool = (provider: string): PiPool =>
  provider === "openai-codex" ? "chatgptPlan" : "apiKeys";

const launchError = (spec: RunSpec, message: string, cause: unknown) =>
  new SessionOperationError({
    operation: "launch",
    sessionId: Option.some(parentSessionId(spec.attemptId)),
    message,
    cause,
  });

const selectModel = Effect.fn("ParentModel.select")(function* (
  models: Models,
  defaultModel: Option.Option<ModelRef>,
  spec: RunSpec,
) {
  if (Option.isSome(spec.parentModel)) {
    const named = spec.parentModel.value;
    const found = Option.flatMap(splitModel(named), (ref) =>
      Option.fromNullishOr(models.getModel(ref.provider, ref.modelId)),
    );
    if (Option.isNone(found)) {
      yield* Effect.logError("Pi parent rejected an unknown model", { model: named });
      return yield* new UnknownModelError({
        harness: "pi",
        model: named,
        message: `Pi does not expose model ${named}`,
      });
    }
    return found.value;
  }
  const configured = Option.flatMap(defaultModel, (ref) =>
    Option.fromNullishOr(models.getModel(ref.provider, ref.modelId)),
  );
  if (Option.isSome(configured)) {
    yield* Effect.logDebug("Pi parent uses the configured default model");
    return configured.value;
  }
  const available = yield* Effect.tryPromise({
    try: (signal) => models.getAvailable(undefined, { signal }),
    catch: (cause) =>
      launchError(spec, "Could not list the models with a configured credential", cause),
  });
  const first = available[0];
  if (first === undefined) {
    const model = ModelId.make("unknown");
    yield* Effect.logError("Pi parent has no model with a configured credential");
    return yield* new UnknownModelError({
      harness: "pi",
      model,
      message: "Pi has no model with a configured credential for the parent",
    });
  }
  yield* Effect.logDebug("Pi parent uses the first model with a configured credential");
  return first;
});

/**
 * Resolves the parent's model, effort, and billing pool exactly as a Pi parent
 * session did before it ran in the orchestrator: an unknown model, an effort the
 * model cannot run, and a credential outside the provider's pool all fail
 * before the conversation is created.
 */
export const resolveParent = Effect.fn("ParentModel.resolve")(function* (
  models: Models,
  defaultModel: Option.Option<ModelRef>,
  spec: RunSpec,
) {
  yield* Effect.annotateCurrentSpan({
    attemptId: spec.attemptId,
    parentEffort: spec.parentEffort,
    parentModel: Option.getOrUndefined(spec.parentModel),
  });
  const selected = yield* selectModel(models, defaultModel, spec);
  const model = ModelId.make(`${selected.provider}/${selected.id}`);
  const supported = getSupportedThinkingLevels(selected);
  if (!supported.includes(spec.parentEffort)) {
    yield* Effect.logError("Pi parent rejected an unsupported effort", {
      effort: spec.parentEffort,
      model,
      supported,
    });
    return yield* new UnsupportedEffortError({
      harness: "pi",
      model,
      effort: spec.parentEffort,
      message: `Pi model ${model} does not support effort ${spec.parentEffort}; supported: ${supported.join(", ")}`,
    });
  }
  const authentication = yield* Effect.tryPromise({
    try: (signal) => models.checkAuth(selected.provider, { signal }),
    catch: (cause) => launchError(spec, "Could not check the parent model's credential", cause),
  });
  const required = requiredPool(selected.provider);
  const unavailable = new PoolUnavailableError({
    harness: "pi",
    model,
    pool: required,
    message: `Pi parent model ${model} requires a credential from the ${required} pool`,
  });
  if (authentication === undefined) {
    yield* Effect.logError("Pi parent has no credential for its model", {
      model,
      requiredPool: required,
    });
    return yield* unavailable;
  }
  if (authentication.type === "api_key") {
    yield* Effect.logInfo("Pi parent authenticated", { model, pool: "apiKeys" });
    return {
      ref: { provider: selected.provider, modelId: selected.id },
      model,
      pool: "apiKeys",
    } satisfies ResolvedParent;
  }
  const subscription = models.getProvider(selected.provider)?.auth.oauth?.isSubscription === true;
  if (!subscription || required !== "chatgptPlan") {
    yield* Effect.logError("Pi parent model has unsupported OAuth authentication", {
      model,
      requiredPool: required,
      subscription,
    });
    return yield* unavailable;
  }
  yield* Effect.logInfo("Pi parent authenticated", { model, pool: "chatgptPlan" });
  return {
    ref: { provider: selected.provider, modelId: selected.id },
    model,
    pool: "chatgptPlan",
  } satisfies ResolvedParent;
});
