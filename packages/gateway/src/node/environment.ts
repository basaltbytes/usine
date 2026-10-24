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

/** The allowlist path if `USINE_GATEWAY_EGRESS_ALLOWLIST` isn't set. */
export const DEFAULT_EGRESS_ALLOWLIST_PATH = "/etc/usine-gateway/egress-allowlist";

const Secret = Schema.RedactedFromValue(Schema.NonEmptyString);

const upstream = (name: string, fallback: string) =>
  Config.schema(UpstreamBase, name).pipe(Config.withDefault(UpstreamBase.make(fallback)));

/** The error when both an Anthropic API key and a subscription token are set. */
export class ConflictingAnthropicCredentials extends Schema.TaggedError<ConflictingAnthropicCredentials>()(
  "ConflictingAnthropicCredentials",
  { message: Schema.String },
) {}

/** The error when a file listed in `USINE_GATEWAY_ENVIRONMENT_FILES` can't be read. */
export class EnvironmentFileError extends Schema.TaggedError<EnvironmentFileError>()(
  "EnvironmentFileError",
  { path: Schema.String, message: Schema.String },
) {}

/** The Gateway's settings source: its environment files layered over the process environment. */
export interface SettingsSource {
  /** The environment files in read order; empty if none is listed. */
  readonly files: ReadonlyArray<string>;
  readonly provider: ConfigProvider.ConfigProvider;
}

/**
 * Reads the `:`-separated environment files listed in `USINE_GATEWAY_ENVIRONMENT_FILES` in
 * `base`, one `KEY=value` per line, and layers them over `base`. Later files override earlier
 * ones, as with systemd's `EnvironmentFile=`. Without that variable, returns `base` alone.
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

/** The LLM providers and credentials from the settings. */
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
        "ANTHROPIC_API_KEY and USINE_GATEWAY_ANTHROPIC_SUBSCRIPTION_TOKEN are both set, and the gateway sends only one Anthropic credential. Unset one of them.",
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

export interface Listener {
  readonly host: string;
  readonly port: number;
}

/** The listeners for the reverse proxy (GitHub and LLMs), the forward proxy (allowlisted hosts), and the admin API (executor). */
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
 * Listeners from the environment. The proxies default to loopback, so an unconfigured Gateway
 * is unreachable; the VM's unit sets its private address.
 */
export const listenersFromEnvironment = Config.all({
  proxy: listener("USINE_GATEWAY_PROXY", "127.0.0.1", 80),
  egress: listener("USINE_GATEWAY_EGRESS", "127.0.0.1", 3128),
  admin: listener("USINE_GATEWAY_ADMIN", "127.0.0.1", 7070),
});

/** The settings that only a restart changes: the domain, the listeners, the admin token, and the caller key that signs all caller tokens. */
export interface RestartSettings {
  readonly domain: GatewayDomain;
  readonly adminToken: AdminToken;
  readonly callerKey: CallerKey;
  readonly listeners: GatewayListeners;
}

export const restartSettings: Config.Config<RestartSettings> = Config.all({
  domain: Config.schema(GatewayDomain, "USINE_GATEWAY_DOMAIN"),
  adminToken: Config.schema(AdminToken, "USINE_GATEWAY_ADMIN_TOKEN"),
  callerKey: Config.schema(CallerKey, "USINE_GATEWAY_CALLER_KEY"),
  listeners: listenersFromEnvironment,
});

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
 * Reads the Gateway's settings from `source`. Fails on a missing secret, an invalid value, or
 * an unreadable allowlist, so the Gateway stops before it listens.
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
 * The Gateway's settings, read once at startup from the files in
 * `USINE_GATEWAY_ENVIRONMENT_FILES` over the process environment, plus the egress allowlist
 * file. Fails on a missing secret, an invalid value, or an unreadable file.
 */
export const settingsFromEnvironment = Layer.effect(
  GatewaySettings,
  Effect.gen(function* () {
    const source = yield* readSettingsSource(yield* ConfigProvider.ConfigProvider);
    const { settings } = yield* readStartupSettings(source);
    return settings;
  }),
);
