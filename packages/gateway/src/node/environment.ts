import { Config, Effect, FileSystem, Layer, Option, Schema } from "effect";
import { parseEgressAllowlist } from "../egress/egress.ts";
import { GITHUB_ORIGINS } from "../github/github.ts";
import {
  AnthropicApiKey,
  AnthropicProvider,
  AnthropicSubscriptionToken,
  type LlmProviders,
  OpenAiProvider,
} from "../llm/llm.ts";
import { AdminToken, CallerKey, GatewayDomain, GatewaySettings } from "../settings.ts";
import { UpstreamBase } from "../upstream.ts";

/** Where the gateway reads its egress allowlist when `USINE_GATEWAY_EGRESS_ALLOWLIST` is not set. */
export const DEFAULT_EGRESS_ALLOWLIST_PATH = "/etc/usine-gateway/egress-allowlist";

const Secret = Schema.RedactedFromValue(Schema.NonEmptyString);

const upstream = (name: string, fallback: string) =>
  Config.schema(UpstreamBase, name).pipe(Config.withDefault(UpstreamBase.make(fallback)));

/** The gateway set an Anthropic API key and a subscription token at once; only one can be sent. */
export class ConflictingAnthropicCredentials extends Schema.TaggedError<ConflictingAnthropicCredentials>()(
  "ConflictingAnthropicCredentials",
  { message: Schema.String },
) {}

const providers = Effect.gen(function* () {
  const anthropicKey = yield* Config.option(Config.schema(Secret, "ANTHROPIC_API_KEY"));
  const subscription = yield* Config.option(
    Config.schema(Secret, "USINE_GATEWAY_ANTHROPIC_SUBSCRIPTION_TOKEN"),
  );
  const openAiKey = yield* Config.option(Config.schema(Secret, "OPENAI_API_KEY"));
  const anthropicUpstream = yield* upstream(
    "USINE_GATEWAY_ANTHROPIC_UPSTREAM",
    "https://api.anthropic.com",
  );
  const openAiUpstream = yield* upstream("USINE_GATEWAY_OPENAI_UPSTREAM", "https://api.openai.com");
  if (Option.isSome(anthropicKey) && Option.isSome(subscription))
    return yield* new ConflictingAnthropicCredentials({
      message:
        "Set ANTHROPIC_API_KEY or USINE_GATEWAY_ANTHROPIC_SUBSCRIPTION_TOKEN, not both: the gateway sends one Anthropic credential.",
    });
  const anthropicCredential = Option.orElse(
    Option.map(anthropicKey, (key) => new AnthropicApiKey({ key })),
    () => Option.map(subscription, (token) => new AnthropicSubscriptionToken({ token })),
  );
  return {
    anthropic: Option.map(
      anthropicCredential,
      (credential) => new AnthropicProvider({ upstream: anthropicUpstream, credential }),
    ),
    openai: Option.map(openAiKey, (key) => new OpenAiProvider({ upstream: openAiUpstream, key })),
  } satisfies LlmProviders;
});

/**
 * Reads the gateway's settings once at startup: the domain and secrets from
 * the environment, and the egress allowlist from its file. A missing secret,
 * an invalid value, or an unreadable allowlist stops the gateway before it
 * listens.
 */
export const settingsFromEnvironment = Layer.effect(
  GatewaySettings,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const domain = yield* Config.schema(GatewayDomain, "USINE_GATEWAY_DOMAIN");
    const adminToken = yield* Config.schema(AdminToken, "USINE_GATEWAY_ADMIN_TOKEN");
    const callerKey = yield* Config.schema(CallerKey, "USINE_GATEWAY_CALLER_KEY");
    const allowlistPath = yield* Config.string("USINE_GATEWAY_EGRESS_ALLOWLIST").pipe(
      Config.withDefault(DEFAULT_EGRESS_ALLOWLIST_PATH),
    );
    const egress = yield* fs
      .readFileString(allowlistPath)
      .pipe(Effect.flatMap((text) => Effect.fromResult(parseEgressAllowlist(text))));
    yield* Effect.logInfo("Loaded the egress allowlist", {
      path: allowlistPath,
      rules: egress.rules.length,
    });
    const llm = yield* providers;
    yield* Effect.logInfo("Configured LLM providers", {
      anthropic: Option.match(llm.anthropic, {
        onNone: () => "none",
        onSome: (provider) => provider.credential._tag,
      }),
      openai: Option.isSome(llm.openai) ? "OpenAiApiKey" : "none",
    });
    return { domain, github: GITHUB_ORIGINS, providers: llm, egress, adminToken, callerKey };
  }),
);

/** An address and port a gateway server listens on. */
export interface Listener {
  readonly host: string;
  readonly port: number;
}

/**
 * The three listeners: the reverse proxy Workers reach for GitHub and the
 * LLMs, the forward proxy for allowlisted hosts, and the admin API for the
 * executor.
 */
export interface GatewayListeners {
  readonly proxy: Listener;
  readonly egress: Listener;
  readonly admin: Listener;
}

const listener = (prefix: string, host: string, port: number) =>
  Config.all({
    host: Config.string(`${prefix}_HOST`).pipe(Config.withDefault(host)),
    port: Config.port(`${prefix}_PORT`).pipe(Config.withDefault(port)),
  });

/**
 * Listeners from the environment. The proxies default to loopback so that a
 * gateway started without configuration is reachable from nowhere; the VM's
 * unit sets them to its private address.
 */
export const listenersFromEnvironment = Config.all({
  proxy: listener("USINE_GATEWAY_PROXY", "127.0.0.1", 80),
  egress: listener("USINE_GATEWAY_EGRESS", "127.0.0.1", 3128),
  admin: listener("USINE_GATEWAY_ADMIN", "127.0.0.1", 7070),
});
