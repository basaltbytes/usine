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
      methods: Option.some({
        [RoutePattern.make("/v1/messages")]: ["POST"],
        [RoutePattern.make("/v1/messages/count_tokens")]: ["POST"],
        [RoutePattern.make("/v1/models")]: ["GET"],
        [RoutePattern.make("/v1/models/{model}")]: ["GET"],
      }),
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
      methods: Option.some({
        [RoutePattern.make("/v1/responses")]: ["POST"],
        [RoutePattern.make("/v1/responses/compact")]: ["POST"],
        [RoutePattern.make("/v1/models")]: ["GET"],
      }),
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

/** The `{model}` route of a Google Generative Language API stream. */
const STREAM_GENERATE_CONTENT = RoutePattern.make("/models/{model}:streamGenerateContent");

/**
 * The OpenCode Go plan, for OpenCode, whose provider ID it keeps. Its one base URL serves three
 * protocols, each at its own upstream with the key in its own header. Its key reaches the plan
 * only through the gateway, so it has no subscription login and no upstream variable.
 */
export const opencodeGo = ModelProvider.make({
  id: ModelProviderId.make("opencode-go"),
  slot: GatewaySlot.make("opencode-go"),
  label: "OpenCode Go",
  protocols: [
    ProviderProtocol.make({
      protocol: WireProtocol.make("openai-compatible"),
      upstream: UpstreamBase.make("https://opencode.ai/inference/go/openai/v1"),
      routes: Arr.map(["/chat/completions", "/responses"] as const, (route) =>
        RoutePattern.make(route),
      ),
      key: KeyHeader.make({ header: HeaderName.make("authorization"), scheme: "bearer" }),
      methods: Option.some({
        [RoutePattern.make("/chat/completions")]: ["POST"],
        [RoutePattern.make("/responses")]: ["POST"],
      }),
    }),
    ProviderProtocol.make({
      protocol: WireProtocol.make("anthropic-messages"),
      upstream: UpstreamBase.make("https://opencode.ai/inference/go/anthropic/v1"),
      routes: [RoutePattern.make("/messages")],
      key: KeyHeader.make({ header: HeaderName.make("x-api-key"), scheme: "none" }),
      methods: Option.some({ [RoutePattern.make("/messages")]: ["POST"] }),
    }),
    ProviderProtocol.make({
      protocol: WireProtocol.make("google-generate-content"),
      upstream: UpstreamBase.make("https://opencode.ai/inference/go/google/v1beta"),
      routes: [STREAM_GENERATE_CONTENT],
      key: KeyHeader.make({ header: HeaderName.make("x-goog-api-key"), scheme: "none" }),
      methods: Option.some({ [STREAM_GENERATE_CONTENT]: ["POST"] }),
    }),
  ],
  credentials: [ApiKeyCredential.make({ variable: GatewayVariable.make("OPENCODE_GO_API_KEY") })],
  // OpenCode's session headers keep the plan's cache affinity; the Anthropic protocol needs its
  // version and beta headers.
  passThrough: Option.some(
    Arr.map(
      [
        "x-opencode-session-id",
        "x-opencode-session",
        "x-session-affinity",
        "x-session-id",
        "x-opencode-project",
        "x-opencode-client",
        "anthropic-version",
        "anthropic-beta",
      ] as const,
      (header) => HeaderName.make(header),
    ),
  ),
});

/**
 * The model providers that the gateway serves. The harness catalog in `@usine/agents/harness`
 * declares the same entries.
 */
export const modelProviders = ModelProviderCatalog.make({
  providers: [anthropic, openai, opencodeGo],
});

export {
  AcceptedCredential,
  ApiKeyCredential,
  GatewaySlot,
  GatewayVariable,
  HeaderName,
  HOP_BY_HOP_HEADERS,
  KeyHeader,
  ModelProvider,
  ModelProviderCatalog,
  ModelProviderId,
  ProviderProtocol,
  type ProviderSelectors,
  RouteMethod,
  RoutePattern,
  selectProvider,
  type SlotTarget,
  SubscriptionCredential,
  SubscriptionLogin,
  UpstreamBase,
  WireProtocol,
} from "./provider.ts";
