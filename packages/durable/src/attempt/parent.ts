import { admitBrain, AdmissionContext, catalog } from "@usine/agents/harness";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { ModelRef } from "@earendil-works/pi-durable";
import {
  piAuthentication,
  type PiPool,
  requiredPiPool,
  resolvePiPool,
  splitPiModel,
} from "@usine/agents/pi/authentication";
import {
  PoolUnavailableError,
  SessionOperationError,
  UnknownModelError,
  UnsupportedEffortError,
} from "@usine/agents/runtime";
import { Harness, BrainSpec, ModelId } from "@usine/core/agent/brain";
import { AgentSessionId, EndpointName, ParentSession } from "@usine/core/agent/session";
import type { AttemptId } from "@usine/core/attempt";
import type { RunSpec } from "@usine/core/attempt/channel";
import { Effect, Option } from "effect";
import type { DurableHarness } from "../harness.ts";
import type { AttemptRecord } from "./documents.ts";

/** The parent model, validated against the effort and credential. */
interface ResolvedParent {
  readonly ref: ModelRef;
  readonly model: ModelId;
  readonly pool: PiPool;
  readonly endpoint: Option.Option<EndpointName>;
}

/** Returns the session ID of the Attempt's Pi parent, the default target of operator input. */
export const parentSessionId = (attemptId: AttemptId): AgentSessionId =>
  AgentSessionId.make(`parent:${attemptId}`);

/** Returns the parent session with the rostered Agent and the resolved model. */
export const parentSession = (
  spec: RunSpec,
  model: ModelId,
  record: Pick<AttemptRecord, "parentPool" | "parentEndpoint">,
): ParentSession =>
  ParentSession.make({
    id: parentSessionId(spec.attemptId),
    agent: spec.agent.name,
    pool: Option.fromUndefinedOr(record.parentPool),
    endpoint: Option.fromNullishOr(record.parentEndpoint),
    brain: BrainSpec.make({ harness: Harness.make("pi"), model, effort: spec.parentEffort }),
  });

export type ParentBrainOptions = Pick<RunSpec, "parentModel" | "parentEffort">;

const launchError = (sessionId: Option.Option<AgentSessionId>, message: string, cause: unknown) =>
  SessionOperationError.make({
    operation: "launch",
    sessionId,
    message,
    cause,
  });

type ParentModels = Pick<DurableHarness["Service"], "models" | "defaultModel" | "credentials">;

const checkAuthentication = Effect.fn("ParentModel.authentication")(function* (
  { models, credentials }: ParentModels,
  provider: string,
  sessionId: Option.Option<AgentSessionId>,
) {
  yield* Effect.annotateCurrentSpan({ provider });
  return yield* credentials.route === "gateway"
    ? credentials
        .authentication(provider)
        .pipe(
          Effect.mapError((cause) =>
            launchError(
              sessionId,
              `Gateway unreachable for provider "${provider}": ${cause.message}`,
              cause,
            ),
          ),
        )
    : Effect.tryPromise({
        try: (signal) => models.checkAuth(provider, { signal }),
        catch: (cause) =>
          launchError(sessionId, "Can't check the parent model's credential", cause),
      }).pipe(
        Effect.map((auth) =>
          piAuthentication(auth, models.getProvider(provider)?.auth.oauth?.isSubscription === true),
        ),
      );
});

const selectModel = Effect.fn("ParentModel.select")(function* (
  parents: ParentModels,
  spec: ParentBrainOptions,
  sessionId: Option.Option<AgentSessionId> = Option.none(),
) {
  const { models, defaultModel, credentials } = parents;
  if (Option.isSome(spec.parentModel)) {
    const named = spec.parentModel.value;
    const found = Option.flatMap(Option.fromNullishOr(splitPiModel(named)), (ref) =>
      Option.fromNullishOr(models.getModel(ref.provider, ref.modelId)),
    );
    if (Option.isNone(found)) {
      yield* Effect.logError("Pi parent rejected an unknown model", { model: named });
      return yield* UnknownModelError.make({
        harness: Harness.make("pi"),
        model: named,
        message: `Pi has no model "${named}"`,
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
      launchError(sessionId, "Can't list the models that have a configured credential", cause),
  });
  let first = available[0];
  if (credentials.route === "gateway") {
    first = undefined;
    for (const provider of new Set(available.map((model) => model.provider))) {
      const authentication = yield* checkAuthentication(parents, provider, sessionId);
      if (resolvePiPool(provider, authentication) === undefined) continue;
      first = available.find((model) => model.provider === provider);
      break;
    }
  }
  if (first === undefined) {
    const model = ModelId.make("unknown");
    yield* Effect.logError("Pi parent has no model with a configured credential");
    return yield* UnknownModelError.make({
      harness: Harness.make("pi"),
      model,
      message: "Pi has no model with a configured credential for the parent",
    });
  }
  yield* Effect.logDebug("Pi parent uses the first model with a configured credential");
  return first;
});

/**
 * Resolves the parent's model, effort, and billing pool. Fails before the conversation is created
 * if the model is unknown, doesn't support the effort, or the credential is outside the provider's
 * pool.
 */
export const resolveParent = Effect.fn("ParentModel.resolve")(function* (
  parents: ParentModels,
  spec: ParentBrainOptions,
  sessionId: Option.Option<AgentSessionId> = Option.none(),
) {
  yield* Effect.annotateCurrentSpan({
    sessionId: Option.getOrUndefined(sessionId),
    parentEffort: spec.parentEffort,
    parentModel: Option.getOrUndefined(spec.parentModel),
  });
  const { credentials } = parents;
  const selected = yield* selectModel(parents, spec, sessionId);
  const model = ModelId.make(`${selected.provider}/${selected.id}`);
  yield* Effect.fromResult(
    admitBrain(
      catalog,
      "coordinator",
      BrainSpec.make({
        harness: Harness.make("pi"),
        model,
        effort: spec.parentEffort,
      }),
      AdmissionContext.make({
        placement: "orchestrator",
        credential: credentials.route,
      }),
    ),
  ).pipe(
    Effect.tapError((error) =>
      Effect.logWarning("Coordinator brain refused", {
        role: error.role,
        model,
        missing: error.missing,
      }),
    ),
    Effect.mapError((cause) => launchError(sessionId, cause.message, cause)),
  );
  const supported = getSupportedThinkingLevels(selected);
  if (!supported.includes(spec.parentEffort)) {
    yield* Effect.logError("Pi parent rejected an unsupported effort", {
      effort: spec.parentEffort,
      model,
      supported,
    });
    return yield* UnsupportedEffortError.make({
      harness: Harness.make("pi"),
      model,
      effort: spec.parentEffort,
      message: `Pi model "${model}" doesn't support effort ${spec.parentEffort}. Supported efforts: ${supported.join(", ")}`,
    });
  }
  const authentication = yield* checkAuthentication(parents, selected.provider, sessionId);
  const required = requiredPiPool(selected.provider);
  const pool = resolvePiPool(selected.provider, authentication);
  if (pool === undefined) {
    yield* Effect.logError(
      authentication === undefined
        ? "Pi parent has no credential for its model"
        : "Pi parent model has unsupported OAuth authentication",
      { model, requiredPool: required, authentication: authentication?._tag },
    );
    return yield* PoolUnavailableError.make({
      harness: Harness.make("pi"),
      model,
      pool: required,
      message:
        credentials.route === "host-login"
          ? `Pi parent model "${model}" requires a credential from the ${required} pool`
          : `Gateway credential unavailable for provider "${selected.provider}" (coordinator model "${model}", pool ${required})`,
    });
  }
  yield* Effect.logInfo("Pi parent authenticated", { model, pool });
  return {
    ref: { provider: selected.provider, modelId: selected.id },
    model,
    pool,
    endpoint:
      pool === "apiKeys" ? Option.some(EndpointName.make(selected.provider)) : Option.none(),
  } satisfies ResolvedParent;
});
