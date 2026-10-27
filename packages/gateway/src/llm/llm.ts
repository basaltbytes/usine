import { type GatewayCredentialKind, GatewayLlmProvider } from "@usine/core/worker";
import { Option, Redacted, Schema } from "effect";
import { Headers } from "effect/http";
import { UpstreamBase } from "../upstream.ts";

const Secret = Schema.Redacted(Schema.NonEmptyString);

/** An Anthropic API key, sent upstream as `x-api-key`. */
export class AnthropicApiKey extends Schema.TaggedClass<AnthropicApiKey>()("AnthropicApiKey", {
  key: Secret,
}) {}

/**
 * A Claude subscription token from `claude setup-token`, sent upstream as a bearer token with
 * the OAuth beta flag. The token is valid for one year and has no refresh token. Anthropic
 * doesn't document swapping a placeholder for one through a proxy; `test/placeholder-swap`
 * checks that it works.
 */
export class AnthropicSubscriptionToken extends Schema.TaggedClass<AnthropicSubscriptionToken>()(
  "AnthropicSubscriptionToken",
  { token: Secret },
) {}

/** The credential added to Anthropic requests. */
export const AnthropicCredential = Schema.Union([AnthropicApiKey, AnthropicSubscriptionToken]);
export type AnthropicCredential = typeof AnthropicCredential.Type;

/** Claude Code's upstream. On the Worker, `ANTHROPIC_BASE_URL` is `http://llm.<domain>/anthropic`. */
export class AnthropicProvider extends Schema.TaggedClass<AnthropicProvider>()(
  "AnthropicProvider",
  { upstream: UpstreamBase, credential: AnthropicCredential },
) {}

/** An OpenAI-compatible API key, sent upstream as a bearer token. */
export class OpenAiApiKey extends Schema.TaggedClass<OpenAiApiKey>()("OpenAiApiKey", {
  key: Secret,
}) {}

/** An absolute path to a file on the Gateway host. */
export const HostFilePath = Schema.String.check(
  Schema.isPattern(/^\/\S*[^/\s]$/u, { message: "Expected an absolute file path" }),
).pipe(Schema.brand("HostFilePath"));
export type HostFilePath = typeof HostFilePath.Type;

/**
 * A ChatGPT login from `codex login`, read from the `auth.json` that Codex writes. The Gateway
 * keeps its tokens in memory, refreshes them at `tokenUrl` before they expire, and writes the
 * rotated tokens back to `authFile`.
 */
export class ChatGptLogin extends Schema.TaggedClass<ChatGptLogin>()("ChatGptLogin", {
  authFile: HostFilePath,
  tokenUrl: UpstreamBase,
}) {}

/** The credential added to OpenAI requests. */
export const OpenAiCredential = Schema.Union([OpenAiApiKey, ChatGptLogin]);
export type OpenAiCredential = typeof OpenAiCredential.Type;

/**
 * Codex's upstream: an OpenAI-compatible API with an API key, or the ChatGPT backend with a
 * ChatGPT login. On the Worker, the `model_provider` `base_url` is `http://llm.<domain>/openai/v1`
 * in both cases.
 */
export class OpenAiProvider extends Schema.TaggedClass<OpenAiProvider>()("OpenAiProvider", {
  upstream: UpstreamBase,
  credential: OpenAiCredential,
}) {}

/** The LLM upstreams the Gateway forwards to. Requests for a provider without a credential are refused. */
export interface LlmProviders {
  readonly anthropic: Option.Option<AnthropicProvider>;
  readonly openai: Option.Option<OpenAiProvider>;
}

/** A provider with its credential. */
export type LlmProvider = AnthropicProvider | OpenAiProvider;

/** The `llm.<domain>` path prefixes that select a provider. */
export const LlmProviderName = GatewayLlmProvider;
export type LlmProviderName = GatewayLlmProvider;

const isProviderName = Schema.is(LlmProviderName);

/** An LLM request's provider and the path after its prefix. */
export interface LlmTarget {
  readonly provider: LlmProviderName;
  readonly rest: string;
}

/** Returns the provider from the first path segment; for example, `/anthropic/v1/messages` is Anthropic's `/v1/messages`. */
export const llmTarget = (pathname: string): Option.Option<LlmTarget> => {
  const match = /^\/([a-z]+)(\/.*)?$/u.exec(pathname);
  const provider = match?.[1];
  if (match === null || provider === undefined || !isProviderName(provider)) return Option.none();
  return Option.some({ provider, rest: match[2] ?? "" });
};

/** Returns the credential kind sent to `provider`: a subscription for a Claude token or a ChatGPT login. */
export const credentialKind = (provider: LlmProvider): GatewayCredentialKind => {
  switch (provider.credential._tag) {
    case "AnthropicApiKey":
    case "OpenAiApiKey":
      return "api-key";
    case "AnthropicSubscriptionToken":
    case "ChatGptLogin":
      return "subscription";
  }
};

/** Returns the configured provider for `name` as a single forwardable value. */
export const configuredProvider = (
  providers: LlmProviders,
  name: LlmProviderName,
): Option.Option<LlmProvider> => (name === "anthropic" ? providers.anthropic : providers.openai);

/**
 * The routes each provider serves after its prefix: those Claude Code and Codex call. Each
 * pattern matches whole plain segments, so a percent-encoded separator or a dot segment never
 * matches, and other parts of the provider's API, such as files or organization administration,
 * can't be reached with the Gateway's credential.
 */
const LLM_ROUTES = {
  anthropic: [
    /^\/v1\/messages$/u,
    /^\/v1\/messages\/count_tokens$/u,
    /^\/v1\/models$/u,
    /^\/v1\/models\/[A-Za-z0-9][A-Za-z0-9._-]*$/u,
  ],
  openai: [/^\/v1\/responses$/u, /^\/v1\/responses\/compact$/u, /^\/v1\/models$/u],
} as const satisfies Record<LlmProviderName, ReadonlyArray<RegExp>>;

/**
 * Returns the upstream path for `rest`, the path after the provider's prefix, if it's one of the
 * provider's `LLM_ROUTES`. Codex calls `<base_url>/responses` with `base_url` ending in `/v1`;
 * the ChatGPT backend serves the same routes without `/v1`, so with a ChatGPT login
 * `/v1/responses` is the backend's `/responses`.
 */
export const llmRoute = (provider: LlmProvider, rest: string): Option.Option<string> => {
  const routes = provider._tag === "AnthropicProvider" ? LLM_ROUTES.anthropic : LLM_ROUTES.openai;
  if (!routes.some((route) => route.test(rest))) return Option.none();
  return Option.some(provider.credential._tag === "ChatGptLogin" ? rest.slice("/v1".length) : rest);
};

const OAUTH_BETA = "oauth-2025-04-20";

const withBeta = (incoming: Option.Option<string>, flag: string): string => {
  const flags = Option.match(incoming, {
    onNone: (): ReadonlyArray<string> => [],
    onSome: (value) =>
      value
        .split(",")
        .map((part) => part.trim())
        .filter((part) => part !== ""),
  });
  return (flags.includes(flag) ? flags : [...flags, flag]).join(",");
};

/** A credential sent as it's configured, without a refresh. */
export type StaticCredential = AnthropicApiKey | AnthropicSubscriptionToken | OpenAiApiKey;

/**
 * Adds `credential` to headers without the caller's credential. For a subscription token, also
 * merges the OAuth beta flag into the harness's flags.
 */
export const withStaticCredential = (
  credential: StaticCredential,
  headers: Headers.Headers,
): Headers.Headers => {
  switch (credential._tag) {
    case "OpenAiApiKey":
      return Headers.set(headers, "authorization", `Bearer ${Redacted.value(credential.key)}`);
    case "AnthropicApiKey":
      return Headers.set(headers, "x-api-key", Redacted.value(credential.key));
    case "AnthropicSubscriptionToken":
      return Headers.setAll(headers, {
        authorization: `Bearer ${Redacted.value(credential.token)}`,
        "anthropic-beta": withBeta(Headers.get(headers, "anthropic-beta"), OAUTH_BETA),
      });
  }
};

/** A ChatGPT login's current access token and account, as Codex sends them to the ChatGPT backend. */
export interface ChatGptAccess {
  readonly accessToken: Redacted.Redacted<string>;
  /** The ChatGPT account or workspace ID, sent as `ChatGPT-Account-ID`; `None` if the login has none. */
  readonly accountId: Option.Option<string>;
}

/**
 * Adds a ChatGPT login's access token as a bearer token and its account as `ChatGPT-Account-ID`,
 * replacing any account header the caller sent. Other headers, such as Codex's `originator` and
 * `session-id`, pass unchanged.
 */
export const withChatGptAccess = (
  access: ChatGptAccess,
  headers: Headers.Headers,
): Headers.Headers => {
  const bearer = Headers.set(
    Headers.remove(headers, "chatgpt-account-id"),
    "authorization",
    `Bearer ${Redacted.value(access.accessToken)}`,
  );
  return Option.match(access.accountId, {
    onNone: () => bearer,
    onSome: (accountId) => Headers.set(bearer, "chatgpt-account-id", accountId),
  });
};
