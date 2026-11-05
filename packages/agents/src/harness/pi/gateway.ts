import type { Api, Model } from "@earendil-works/pi-ai";
import { GatewayCredentialKind, GatewayLlmProtocol } from "@usine/core/worker";
import { HttpClient } from "effect/http";
import { type Brand, Effect, Option, Schema } from "effect";
import { ModelId } from "@usine/core/agent/brain";
import { splitPiModel, type PiPool } from "./authentication.ts";

/** The orchestrator cannot connect to the gateway's model proxy. */
export class PiGatewayConnectionError extends Schema.TaggedError<
  PiGatewayConnectionError,
  Brand.Brand<"@usine/agents/PiGatewayConnectionError">
>()("PiGatewayConnectionError", { message: Schema.NonEmptyString }) {}

/** An orchestrator request's route through an attempt's gateway attachment. */
export class PiGateway extends Schema.Class<PiGateway, Brand.Brand<"@usine/agents/PiGateway">>(
  "PiGateway",
)({
  baseUrl: Schema.declare(
    (value): value is Effect.Effect<string, PiGatewayConnectionError> => Effect.isEffect(value),
    { expected: "a gateway connection effect" },
  ),
  httpClient: Schema.declare(HttpClient.isHttpClient, { expected: "a gateway HTTP client" }),
  host: Schema.NonEmptyString,
  callerToken: Schema.Redacted(Schema.NonEmptyString),
  credentials: Schema.Record(GatewayLlmProtocol, Schema.Option(GatewayCredentialKind)),
}) {}

/** A coordinator model cannot use the configured gateway credential. */
export class PiGatewayUnavailable extends Schema.TaggedError<
  PiGatewayUnavailable,
  Brand.Brand<"@usine/agents/PiGatewayUnavailable">
>()("PiGatewayUnavailable", {
  model: ModelId,
  message: Schema.NonEmptyString,
}) {}

/** Returns the protocol used by a supported Pi provider. */
export const piGatewayProtocol = (provider: string): Option.Option<GatewayLlmProtocol> =>
  provider === "anthropic"
    ? Option.some("anthropic-messages")
    : provider === "openai" || provider === "openai-codex"
      ? Option.some("openai-responses")
      : Option.none();

/** Checks the gateway credential without reading the orchestrator's provider login. */
export const piGatewayPool = Effect.fn("PiGateway.pool")(function* (
  model: ModelId,
  credentials: PiGateway["credentials"],
) {
  yield* Effect.annotateCurrentSpan({ model });
  const provider = splitPiModel(model)?.provider ?? model;
  const protocol = piGatewayProtocol(provider);
  const kind = Option.flatMap(protocol, (protocol) => credentials[protocol]);
  const unavailable = (message: string) => PiGatewayUnavailable.make({ model, message });
  if (Option.isNone(kind)) {
    const message = `The coordinator's gateway has no credential for provider "${provider}" (${Option.getOrElse(protocol, () => "unsupported protocol")}). Configure that provider on the gateway and include its protocol in gateway.llm_providers.`;
    yield* Effect.logWarning("Coordinator gateway credential unavailable", { model, provider });
    return yield* unavailable(message);
  }
  if (kind.value === "subscription" && provider !== "openai-codex") {
    const message = `The coordinator model "${model}" requires an API key on the gateway. Use openai-codex/model for a ChatGPT subscription; Claude subscriptions require Claude Code.`;
    yield* Effect.logWarning("Coordinator gateway credential does not support the model", {
      model,
      provider,
      credential: kind.value,
    });
    return yield* unavailable(message);
  }
  const pool: PiPool = kind.value === "subscription" ? "chatgptPlan" : "apiKeys";
  yield* Effect.logInfo("Coordinator gateway route verified", { model, provider, pool });
  return pool;
});

/** Returns catalog models supported by the gateway's current credential kinds. */
export const piGatewayModels = (
  models: readonly Model<Api>[],
  credentials: PiGateway["credentials"],
) =>
  models.filter((model) =>
    Option.exists(piGatewayProtocol(model.provider), (protocol) =>
      Option.exists(
        credentials[protocol],
        (kind) => kind === "api-key" || model.provider === "openai-codex",
      ),
    ),
  );
