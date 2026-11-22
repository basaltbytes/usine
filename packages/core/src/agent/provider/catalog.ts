import { Array as Arr, Option } from "effect";
import {
  ApiKeyCredential,
  GatewaySlot,
  GatewayVariable,
  HeaderName,
  KeyHeader,
  ModelProvider,
  ModelProviderCatalog,
  ModelProviderId,
  ProviderProtocol,
  RoutePattern,
  SubscriptionCredential,
  UpstreamBase,
  WireProtocol,
} from "./provider.ts";

/** The Anthropic API, for Claude Code. Its slot keeps the name it had before providers were entries. */
export const anthropic = ModelProvider.make({
  id: ModelProviderId.make("anthropic"),
  slot: GatewaySlot.make("anthropic-messages"),
  label: "Anthropic",
  protocols: [
    ProviderProtocol.make({
      protocol: WireProtocol.make("anthropic-messages"),
      upstream: UpstreamBase.make("https://api.anthropic.com"),
      routes: Arr.map(
        ["/v1/messages", "/v1/messages/count_tokens", "/v1/models", "/v1/models/{model}"] as const,
        (route) => RoutePattern.make(route),
      ),
      key: KeyHeader.make({ header: HeaderName.make("x-api-key"), scheme: "none" }),
    }),
  ],
  credentials: [
    ApiKeyCredential.make({ variable: GatewayVariable.make("ANTHROPIC_API_KEY") }),
    SubscriptionCredential.make({
      login: "claude",
      variable: GatewayVariable.make("USINE_GATEWAY_ANTHROPIC_SUBSCRIPTION_TOKEN"),
    }),
  ],
  upstreamVariable: Option.some(GatewayVariable.make("USINE_GATEWAY_ANTHROPIC_UPSTREAM")),
});

/**
 * The OpenAI API, or the ChatGPT backend with a ChatGPT login, for Codex. Its slot keeps the name
 * it had before providers were entries.
 */
export const openai = ModelProvider.make({
  id: ModelProviderId.make("openai"),
  slot: GatewaySlot.make("openai-responses"),
  label: "OpenAI",
  protocols: [
    ProviderProtocol.make({
      protocol: WireProtocol.make("openai-responses"),
      upstream: UpstreamBase.make("https://api.openai.com"),
      routes: Arr.map(["/v1/responses", "/v1/responses/compact", "/v1/models"] as const, (route) =>
        RoutePattern.make(route),
      ),
      key: KeyHeader.make({ header: HeaderName.make("authorization"), scheme: "bearer" }),
    }),
  ],
  credentials: [
    ApiKeyCredential.make({ variable: GatewayVariable.make("OPENAI_API_KEY") }),
    SubscriptionCredential.make({
      login: "chatgpt",
      variable: GatewayVariable.make("USINE_GATEWAY_CHATGPT_AUTH_FILE"),
    }),
  ],
  upstreamVariable: Option.some(GatewayVariable.make("USINE_GATEWAY_OPENAI_UPSTREAM")),
});

/**
 * The model providers that the gateway serves. The harness catalog in `@usine/agents/harness`
 * declares the same entries.
 */
export const modelProviders = ModelProviderCatalog.make({ providers: [anthropic, openai] });

export {
  AcceptedCredential,
  ApiKeyCredential,
  GatewaySlot,
  GatewayVariable,
  HeaderName,
  KeyHeader,
  ModelProvider,
  ModelProviderCatalog,
  ModelProviderId,
  ProviderProtocol,
  RoutePattern,
  routeServes,
  SubscriptionCredential,
  SubscriptionLogin,
  UpstreamBase,
  WireProtocol,
} from "./provider.ts";
