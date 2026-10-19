import { GatewayDomain } from "@usine/core/worker";
import { Config, ConfigProvider, Effect, FileSystem, Layer, Option, Schema } from "effect";
import { parseEgressAllowlist } from "../egress/egress.ts";
import { GITHUB_ORIGINS } from "../github/github.ts";
import {
  AnthropicApiKey,
  AnthropicProvider,
  AnthropicSubscriptionToken,
  type LlmProviders,
  OpenAiProvider,
} from "../llm/llm.ts";
import { AdminToken, CallerKey, GatewaySettings } from "../settings.ts";
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

/** An environment file named in `USINE_GATEWAY_ENVIRONMENT_FILES` could not be read. */
export class EnvironmentFileError extends Schema.TaggedError<EnvironmentFileError>()(
  "EnvironmentFileError",
  { path: Schema.String, message: Schema.String },
) {}

/** Where the gateway's settings come from: its environment files over the process environment. */
export interface SettingsSource {
  /** The environment files, in the order they were read; empty when none is named. */
  readonly files: ReadonlyArray<string>;
  readonly provider: ConfigProvider.ConfigProvider;
}

/**
 * Reads the environment files that `USINE_GATEWAY_ENVIRONMENT_FILES` in
 * `base` names, separated by `:`, each with one `KEY=value` per line, and
 * puts them over `base`: a variable in a later file overrides the same one
 * in an earlier file and in `base`, as systemd's `EnvironmentFile=` does.
 * Without that variable the settings come from `base` alone.
 */
export const readSettingsSource = Effect.fn("GatewayNode.readSettingsSource")(function* (
  base: ConfigProvider.ConfigProvider,
) {
  const fs = yield* FileSystem.FileSystem;
  const named = yield* Config.option(Config.string("USINE_GATEWAY_ENVIRONMENT_FILES")).parse(base);
  const files = Option.match(named, {
    onNone: (): ReadonlyArray<string> => [],
    onSome: (value) => value.split(":").filter((path) => path !== ""),
  });
  const contents = yield* Effect.forEach(files, (path) =>
    fs
      .readFileString(path)
      .pipe(Effect.mapError((error) => new EnvironmentFileError({ path, message: error.message }))),
  );
  const provider = contents.reduce(
    (below, text) => ConfigProvider.fromDotEnvContents(text).pipe(ConfigProvider.orElse(below)),
    base,
  );
  return { files, provider } satisfies SettingsSource;
});

/** The LLM providers the settings configure, with their credentials. */
export const llmProviders = Effect.gen(function* () {
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

/** The allowlist file's path. */
export const egressAllowlistPath = Config.string("USINE_GATEWAY_EGRESS_ALLOWLIST").pipe(
  Config.withDefault(DEFAULT_EGRESS_ALLOWLIST_PATH),
);

/** Reads and parses the allowlist file at `path`. */
export const readEgressAllowlist = Effect.fn("GatewayNode.readEgressAllowlist")(function* (
  path: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const text = yield* fs.readFileString(path);
  return yield* Effect.fromResult(parseEgressAllowlist(text));
});

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

/**
 * The settings only a restart changes: the domain and the listeners the
 * servers are bound to, the admin token, and the caller key, which every
 * caller token in use is signed with.
 */
export interface RestartSettings {
  readonly domain: GatewayDomain;
  readonly adminToken: AdminToken;
  readonly callerKey: CallerKey;
  readonly listeners: GatewayListeners;
}

/** Reads the restart-only settings. */
export const restartSettings: Config.Config<RestartSettings> = Config.all({
  domain: Config.schema(GatewayDomain, "USINE_GATEWAY_DOMAIN"),
  adminToken: Config.schema(AdminToken, "USINE_GATEWAY_ADMIN_TOKEN"),
  callerKey: Config.schema(CallerKey, "USINE_GATEWAY_CALLER_KEY"),
  listeners: listenersFromEnvironment,
});

/** The gateway's settings and listeners as it started. */
export interface StartupSettings {
  readonly settings: GatewaySettings["Service"];
  readonly listeners: GatewayListeners;
}

const startupSettings = Effect.gen(function* () {
  const { domain, adminToken, callerKey, listeners } = yield* restartSettings;
  const path = yield* egressAllowlistPath;
  const egress = yield* readEgressAllowlist(path);
  yield* Effect.logInfo("Loaded the egress allowlist", { path, rules: egress.rules.length });
  const providers = yield* llmProviders;
  yield* Effect.logInfo("Configured LLM providers", {
    anthropic: Option.match(providers.anthropic, {
      onNone: () => "none",
      onSome: (provider) => provider.credential._tag,
    }),
    openai: Option.isSome(providers.openai) ? "OpenAiApiKey" : "none",
  });
  const settings = { domain, github: GITHUB_ORIGINS, providers, egress, adminToken, callerKey };
  return { settings, listeners } satisfies StartupSettings;
});

/**
 * Reads the gateway's settings from `source` at startup. A missing secret,
 * an invalid value, or an unreadable allowlist fails, so the gateway stops
 * before it listens.
 */
export const readStartupSettings = Effect.fn("GatewayNode.readStartupSettings")(function* (
  source: SettingsSource,
) {
  yield* Effect.logInfo("Reading the gateway settings", { environmentFiles: source.files });
  return yield* startupSettings.pipe(
    Effect.provideService(ConfigProvider.ConfigProvider, source.provider),
  );
});

/**
 * Reads the gateway's settings once at startup: the domain and secrets from
 * the environment files that `USINE_GATEWAY_ENVIRONMENT_FILES` names, over
 * the process environment, and the egress allowlist from its file. A missing
 * secret, an invalid value, or an unreadable file stops the gateway before
 * it listens.
 */
export const settingsFromEnvironment = Layer.effect(
  GatewaySettings,
  Effect.gen(function* () {
    const source = yield* readSettingsSource(yield* ConfigProvider.ConfigProvider);
    const { settings } = yield* readStartupSettings(source);
    return settings;
  }),
);
