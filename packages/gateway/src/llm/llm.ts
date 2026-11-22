import {
  type GatewayVariable,
  type KeyHeader,
  type ModelProvider,
  type ModelProviderCatalog,
  type ProviderProtocol,
  UpstreamBase,
} from "@usine/core/agent/provider";
import type { GatewayCredentialKind } from "@usine/core/worker";
import { type Brand, Option, Redacted, Schema } from "effect";
import { Headers } from "effect/http";

const Secret = Schema.Redacted(Schema.NonEmptyString);

/** A static API key, sent in the key header of the protocol that serves each request. */
export class ApiKey extends Schema.TaggedClass<
  ApiKey,
  Brand.Brand<"@usine/gateway/llm/llm/ApiKey">
>()("ApiKey", {
  /** The nonempty API key. */
  key: Secret,
}) {}

/**
 * A Claude subscription token from `claude setup-token`, sent upstream as a bearer token with
 * the OAuth beta flag. The token is valid for one year and has no refresh token. Anthropic
 * doesn't document swapping a placeholder for one through a proxy; `test/placeholder-swap`
 * checks that it works.
 */
export class AnthropicSubscriptionToken extends Schema.TaggedClass<
  AnthropicSubscriptionToken,
  Brand.Brand<"@usine/gateway/llm/llm/AnthropicSubscriptionToken">
>()("AnthropicSubscriptionToken", {
  /** The nonempty Claude subscription token sent as a bearer token with the OAuth beta flag. */
  token: Secret,
}) {}

/** An absolute path to a file on the gateway host. */
export const HostFilePath = Schema.String.check(
  Schema.isPattern(/^\/\S*[^/\s]$/u, { message: "Expected an absolute file path" }),
).pipe(Schema.brand("HostFilePath"));
export type HostFilePath = typeof HostFilePath.Type;

/**
 * A ChatGPT login from `codex login`, read from the `auth.json` that Codex writes. The gateway
 * keeps its tokens in memory, refreshes them at `tokenUrl` before they expire, and writes the
 * rotated tokens back to `authFile`.
 */
export class ChatGptLogin extends Schema.TaggedClass<
  ChatGptLogin,
  Brand.Brand<"@usine/gateway/llm/llm/ChatGptLogin">
>()("ChatGptLogin", {
  /** The absolute path to a Codex ChatGPT auth file. Refreshes require write access to its directory. */
  authFile: HostFilePath,
  /** The OAuth token endpoint used to refresh this login. */
  tokenUrl: UpstreamBase,
}) {}

/** The ChatGPT backend that serves Codex's routes with a ChatGPT login. */
export const CHATGPT_UPSTREAM = UpstreamBase.make("https://chatgpt.com/backend-api/codex");

/** The gateway variable that replaces `CHATGPT_UPSTREAM`. */
export const CHATGPT_UPSTREAM_VARIABLE = "USINE_GATEWAY_CHATGPT_UPSTREAM";

/** The credential that the gateway holds for a provider: an API key, or a subscription login. */
export const LlmCredential = Schema.Union([ApiKey, AnthropicSubscriptionToken, ChatGptLogin]);
export type LlmCredential = typeof LlmCredential.Type;

/**
 * The credential that the gateway holds for a provider's slot, and the base URL that replaces the
 * upstream of each of the provider's protocols, if any.
 */
export class LlmProvider extends Schema.TaggedClass<
  LlmProvider,
  Brand.Brand<"@usine/gateway/llm/llm/LlmProvider">
>()("LlmProvider", {
  /** The upstream base for every protocol, such as a ChatGPT login's backend; `None` for the catalog's. */
  upstream: Schema.Option(UpstreamBase),
  /** The API key or subscription login that replaces the caller token upstream. */
  credential: LlmCredential,
}) {}

/**
 * The providers that the gateway holds a credential for, by slot. Requests for another slot are
 * refused.
 */
export type LlmProviders = Readonly<Record<string, LlmProvider>>;

/** An LLM request's provider, the path after its prefix, and whether the prefix was the provider ID. */
export interface LlmTarget {
  readonly provider: ModelProvider;
  readonly rest: string;
  /** Whether the request named the provider by its ID, as before slots, instead of its slot. */
  readonly legacy: boolean;
}

/**
 * Returns the provider whose slot or ID is the first path segment; for example,
 * `/anthropic-messages/v1/messages` is `/v1/messages` of the provider with that slot.
 */
export const llmTarget = (
  catalog: ModelProviderCatalog,
  pathname: string,
): Option.Option<LlmTarget> => {
  const match = /^\/([a-z0-9-]+)(\/.*)?$/u.exec(pathname);
  if (match === null) return Option.none();
  const prefix = match[1] ?? "";
  return Option.map(catalog.find(prefix), (provider) => ({
    provider,
    rest: match[2] ?? "",
    legacy: prefix !== provider.slot,
  }));
};

/** Returns the credential kind sent to the upstream: a subscription for a Claude token or a ChatGPT login. */
export const credentialKind = ({ credential }: LlmProvider): GatewayCredentialKind =>
  credential._tag === "ApiKey" ? "api-key" : "subscription";

/**
 * Returns the upstream URL of `rest`, a path that `protocol` serves, without the query. The ChatGPT
 * backend serves Codex's routes without `/v1`, so with a ChatGPT login `/v1/responses` is the
 * backend's `/responses`.
 */
export const llmUpstream = (held: LlmProvider, protocol: ProviderProtocol, rest: string) => {
  const base = Option.getOrElse(held.upstream, () => protocol.upstream);
  const path =
    held.credential._tag === "ChatGptLogin" && rest.startsWith("/v1/")
      ? rest.slice("/v1".length)
      : rest;
  return `${base}${path}`;
};

/** The request headers that pass to every upstream that lists the headers it accepts. */
const CONTENT_HEADERS: ReadonlyArray<string> = [
  "accept",
  "accept-encoding",
  "content-encoding",
  "content-length",
  "content-type",
  "user-agent",
];

/**
 * Returns the request headers that pass to `provider`'s upstream: every header, or the content
 * headers and the ones that `passThrough` lists.
 */
export const passingHeaders = (provider: ModelProvider, headers: Headers.Headers) =>
  Option.match(provider.passThrough, {
    onNone: () => headers,
    onSome: (listed) => {
      const kept = new Set<string>([...CONTENT_HEADERS, ...listed]);
      return Headers.removeMany(
        headers,
        Object.keys(headers).filter((name) => !kept.has(name)),
      );
    },
  });

/** Returns the header name of each protocol's key, which can carry a caller token. */
export const keyHeaders = (catalog: ModelProviderCatalog): ReadonlyArray<string> => [
  ...new Set(catalog.providers.flatMap(({ protocols }) => protocols.map(({ key }) => key.header))),
];

/** Returns the gateway variable that sets the upstream of `held`'s credential, if any. */
export const upstreamVariable = (
  provider: ModelProvider,
  held: LlmProvider,
): Option.Option<GatewayVariable | typeof CHATGPT_UPSTREAM_VARIABLE> =>
  held.credential._tag === "ChatGptLogin"
    ? Option.some(CHATGPT_UPSTREAM_VARIABLE)
    : provider.upstreamVariable;

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
export type StaticCredential = ApiKey | AnthropicSubscriptionToken;

/**
 * Adds `credential` to headers without the caller's credential: an API key in `key`, the key
 * header of the request's protocol, or a Claude subscription token as a bearer token with the
 * OAuth beta flag merged into the harness's flags.
 */
export const withStaticCredential = (
  credential: StaticCredential,
  key: KeyHeader,
  headers: Headers.Headers,
): Headers.Headers => {
  switch (credential._tag) {
    case "ApiKey":
      return Headers.set(headers, key.header, key.value(Redacted.value(credential.key)));
    case "AnthropicSubscriptionToken":
      return Headers.setAll(headers, {
        authorization: `Bearer ${Redacted.value(credential.token)}`,
        "anthropic-beta": withBeta(Headers.get(headers, "anthropic-beta"), OAUTH_BETA),
      });
  }
};

/** A ChatGPT login's current access token and account, as Codex sends them to the ChatGPT backend. */
export interface ChatGptAccess {
  /** The current ChatGPT access token to send as a bearer token, redacted in diagnostics. */
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
