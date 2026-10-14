import { Option, Redacted, Schema } from "effect";
import { Headers } from "effect/unstable/http";
import { UpstreamBase } from "../upstream.ts";

const Secret = Schema.Redacted(Schema.NonEmptyString);

/** An Anthropic API key, sent upstream as `x-api-key`. */
export class AnthropicApiKey extends Schema.TaggedClass<AnthropicApiKey>()("AnthropicApiKey", {
  key: Secret,
}) {}

/**
 * A Claude subscription token from `claude setup-token`, sent upstream as a
 * bearer token with the OAuth beta flag. Anthropic does not document a proxy
 * that swaps a placeholder for one; `test/placeholder-swap` checks whether it
 * works before anyone relies on it.
 */
export class AnthropicSubscriptionToken extends Schema.TaggedClass<AnthropicSubscriptionToken>()(
  "AnthropicSubscriptionToken",
  { token: Secret },
) {}

/** The credential the gateway adds to Anthropic requests. */
export const AnthropicCredential = Schema.Union([AnthropicApiKey, AnthropicSubscriptionToken]);
export type AnthropicCredential = typeof AnthropicCredential.Type;

/** Claude Code's upstream: `ANTHROPIC_BASE_URL` on the Worker points at `http://llm.<domain>/anthropic`. */
export class AnthropicProvider extends Schema.TaggedClass<AnthropicProvider>()(
  "AnthropicProvider",
  { upstream: UpstreamBase, credential: AnthropicCredential },
) {}

/**
 * An OpenAI-compatible upstream for Codex: its `model_provider` `base_url` on
 * the Worker is `http://llm.<domain>/openai/v1`. The key is sent as a bearer token.
 */
export class OpenAiProvider extends Schema.TaggedClass<OpenAiProvider>()("OpenAiProvider", {
  upstream: UpstreamBase,
  key: Secret,
}) {}

/** The LLM upstreams the gateway forwards to. A provider without a credential is refused. */
export interface LlmProviders {
  readonly anthropic: Option.Option<AnthropicProvider>;
  readonly openai: Option.Option<OpenAiProvider>;
}

/** The path prefixes on `llm.<domain>` that name a provider. */
const LLM_PROVIDER_NAMES = ["anthropic", "openai"] as const;
export const LlmProviderName = Schema.Literals(LLM_PROVIDER_NAMES);
export type LlmProviderName = typeof LlmProviderName.Type;

const isProviderName = Schema.is(LlmProviderName);

/** A request for an LLM provider: which provider, and the path after its prefix. */
export interface LlmTarget {
  readonly provider: LlmProviderName;
  readonly rest: string;
}

/** Reads the provider from the first path segment: `/anthropic/v1/messages` is Anthropic's `/v1/messages`. */
export const llmTarget = (pathname: string): Option.Option<LlmTarget> => {
  const match = /^\/([a-z]+)(\/.*)?$/u.exec(pathname);
  const provider = match?.[1];
  if (match === null || provider === undefined || !isProviderName(provider)) return Option.none();
  return Option.some({ provider, rest: match[2] ?? "" });
};

/** The configured provider for `name`, as one value the proxy can forward to. */
export const configuredProvider = (
  providers: LlmProviders,
  name: LlmProviderName,
): Option.Option<AnthropicProvider | OpenAiProvider> =>
  name === "anthropic" ? providers.anthropic : providers.openai;

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

/**
 * Adds the provider's credential to request headers the caller's own
 * credential has already been removed from. A subscription token also needs
 * the OAuth beta flag, merged into any flags the harness sent.
 */
export const withProviderCredential = (
  provider: AnthropicProvider | OpenAiProvider,
  headers: Headers.Headers,
): Headers.Headers => {
  switch (provider._tag) {
    case "OpenAiProvider":
      return Headers.set(headers, "authorization", `Bearer ${Redacted.value(provider.key)}`);
    case "AnthropicProvider": {
      const credential = provider.credential;
      switch (credential._tag) {
        case "AnthropicApiKey":
          return Headers.set(headers, "x-api-key", Redacted.value(credential.key));
        case "AnthropicSubscriptionToken":
          return Headers.setAll(headers, {
            authorization: `Bearer ${Redacted.value(credential.token)}`,
            "anthropic-beta": withBeta(Headers.get(headers, "anthropic-beta"), OAUTH_BETA),
          });
      }
    }
  }
};
