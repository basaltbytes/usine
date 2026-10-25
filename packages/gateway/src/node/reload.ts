import {
  Cause,
  ConfigProvider,
  Context,
  Effect,
  FileSystem,
  Layer,
  Option,
  Queue,
  Redacted,
  Semaphore,
} from "effect";
import { ChatGptLogins } from "../chatgpt/logins.ts";
import type { EgressAllowlist } from "../egress/egress.ts";
import type { LlmProvider, LlmProviders } from "../llm/llm.ts";
import { SettingsInForce } from "../settings.ts";
import {
  egressAllowlistPath,
  llmProviders,
  readEgressAllowlist,
  readSettingsSource,
  type RestartSettings,
  restartSettings,
  type SettingsSource,
  type StartupSettings,
} from "./environment.ts";

/**
 * The service that reloads the egress allowlist and LLM providers from the startup environment
 * and allowlist files. Attachments, the admin API, listeners, and open tunnels are unchanged.
 * `usine-gateway` runs it on SIGHUP.
 */
export class GatewayReload extends Context.Service<
  GatewayReload,
  {
    /**
     * Reloads once, after any reload in progress. Never fails: an unreadable or invalid file keeps
     * the current settings, restart-only settings are unchanged, and both cases are logged.
     */
    readonly reload: Effect.Effect<void>;
  }
>()("@usine/gateway/node/GatewayReload") {}

/** Returns each restart-only setting as text, keyed by its variable. */
const restartValues = ({ domain, adminToken, callerKey, listeners }: RestartSettings) => ({
  USINE_GATEWAY_DOMAIN: domain,
  USINE_GATEWAY_ADMIN_TOKEN: Redacted.value(adminToken),
  USINE_GATEWAY_CALLER_KEY: Redacted.value(callerKey),
  USINE_GATEWAY_PROXY_HOST: listeners.proxy.host,
  USINE_GATEWAY_PROXY_PORT: String(listeners.proxy.port),
  USINE_GATEWAY_EGRESS_HOST: listeners.egress.host,
  USINE_GATEWAY_EGRESS_PORT: String(listeners.egress.port),
  USINE_GATEWAY_ADMIN_HOST: listeners.admin.host,
  USINE_GATEWAY_ADMIN_PORT: String(listeners.admin.port),
});

/** Returns each credential variable with its value, or `undefined` if unset. */
const credentialValues = ({ anthropic, openai }: LlmProviders) => {
  const anthropicCredential = Option.getOrUndefined(
    Option.map(anthropic, (provider) => provider.credential),
  );
  const openAiCredential = Option.getOrUndefined(
    Option.map(openai, (provider) => provider.credential),
  );
  return {
    ANTHROPIC_API_KEY:
      anthropicCredential?._tag === "AnthropicApiKey"
        ? Redacted.value(anthropicCredential.key)
        : undefined,
    USINE_GATEWAY_ANTHROPIC_SUBSCRIPTION_TOKEN:
      anthropicCredential?._tag === "AnthropicSubscriptionToken"
        ? Redacted.value(anthropicCredential.token)
        : undefined,
    OPENAI_API_KEY:
      openAiCredential?._tag === "OpenAiApiKey" ? Redacted.value(openAiCredential.key) : undefined,
    USINE_GATEWAY_CHATGPT_AUTH_FILE:
      openAiCredential?._tag === "ChatGptLogin" ? openAiCredential.authFile : undefined,
  };
};

/** The variable that sets each credential's upstream. */
const UPSTREAM_VARIABLES = {
  AnthropicApiKey: "USINE_GATEWAY_ANTHROPIC_UPSTREAM",
  AnthropicSubscriptionToken: "USINE_GATEWAY_ANTHROPIC_UPSTREAM",
  OpenAiApiKey: "USINE_GATEWAY_OPENAI_UPSTREAM",
  ChatGptLogin: "USINE_GATEWAY_CHATGPT_UPSTREAM",
} as const satisfies Record<LlmProvider["credential"]["_tag"], string>;

/** Returns the upstream variables that changed, for providers with the same kind of credential before and after. */
const changedUpstreams = (before: LlmProviders, after: LlmProviders): ReadonlyArray<string> => {
  const changed = (was: Option.Option<LlmProvider>, is: Option.Option<LlmProvider>) =>
    Option.toArray(
      Option.flatMap(
        Option.zipWith(was, is, (left, right) => [left, right] as const),
        ([left, right]) =>
          left.credential._tag === right.credential._tag && left.upstream !== right.upstream
            ? Option.some(UPSTREAM_VARIABLES[right.credential._tag])
            : Option.none(),
      ),
    );
  return [...changed(before.anthropic, after.anthropic), ...changed(before.openai, after.openai)];
};

/** Returns the names of the variables whose values differ, never the values. */
const changedVariables = (
  before: Readonly<Record<string, string | undefined>>,
  after: Readonly<Record<string, string | undefined>>,
): ReadonlyArray<string> => Object.keys(before).filter((name) => before[name] !== after[name]);

/** Logs a warning for restart-only settings that changed or no longer parse. */
const checkRestartSettings = (started: RestartSettings) =>
  restartSettings.pipe(
    Effect.flatMap((now) => {
      const changed = changedVariables(restartValues(started), restartValues(now));
      return changed.length === 0
        ? Effect.void
        : Effect.logWarning("Settings changed that take effect only after a restart", {
            settings: changed,
          });
    }),
    Effect.catchTag("ConfigError", (error) =>
      Effect.logWarning("A restart would fail: a setting only a restart reads is invalid", {
        error: error.message,
      }),
    ),
  );

/** Returns the allowlist path and its new contents, or `None` if it can't be read or parsed. */
const nextAllowlist = (previous: EgressAllowlist) =>
  Effect.gen(function* () {
    // The path has a default, so reading it fails only if the settings source fails, which an in-memory source doesn't.
    const path = yield* Effect.orDie(egressAllowlistPath);
    const kept = (fields: Readonly<Record<string, string | number>>) =>
      Effect.logError("Kept the previous egress allowlist", {
        path,
        ...fields,
        rules: previous.rules.length,
      }).pipe(Effect.as({ path, egress: Option.none<EgressAllowlist>() }));
    return yield* readEgressAllowlist(path).pipe(
      Effect.map((egress) => ({ path, egress: Option.some(egress) })),
      Effect.catchTags({
        EgressAllowlistError: ({ line, message }) => kept({ line, error: message }),
        PlatformError: (error) => kept({ error: error.message }),
      }),
    );
  });

const keptProviders = (error: string) =>
  Effect.logError("Kept the previous LLM providers", { error }).pipe(
    Effect.as(Option.none<LlmProviders>()),
  );

/** The new LLM providers, or `None` if they're invalid. */
const nextProviders = llmProviders.pipe(
  Effect.map(Option.some),
  Effect.catchTags({
    ConfigError: ({ message }) => keptProviders(message),
    ConflictingProviderCredentials: ({ message }) => keptProviders(message),
    ChatGptAuthFileError: ({ message }) => keptProviders(message),
  }),
);

/**
 * Reads a ChatGPT login's auth file again after a reload, so a login the operator copied
 * replaces the one in memory. An unreadable file keeps the login in memory.
 */
const reloadChatGptLogin = (logins: ChatGptLogins["Service"], providers: LlmProviders) => {
  const login = Option.getOrUndefined(Option.map(providers.openai, ({ credential }) => credential));
  if (login?._tag !== "ChatGptLogin") return Effect.void;
  return logins.reload(login).pipe(
    Effect.catchTag("ChatGptAuthFileError", ({ message }) =>
      Effect.logError("Kept the ChatGPT login in memory: its auth file could not be read", {
        authFile: login.authFile,
        error: message,
      }),
    ),
  );
};

/** Returns the reload for a Gateway started with `started`, reading settings from the environment files over `base`. */
export const gatewayReloadLayer = (started: StartupSettings, base: ConfigProvider.ConfigProvider) =>
  Layer.effect(
    GatewayReload,
    Effect.gen(function* () {
      const inForce = yield* SettingsInForce;
      const logins = yield* ChatGptLogins;
      const fileSystem = yield* FileSystem.FileSystem;
      const oneAtATime = yield* Semaphore.make(1);
      const { domain, adminToken, callerKey } = started.settings;
      const startedRestartSettings: RestartSettings = {
        domain,
        adminToken,
        callerKey,
        listeners: started.listeners,
      };

      const reloadFrom = (source: SettingsSource) =>
        Effect.gen(function* () {
          yield* checkRestartSettings(startedRestartSettings);
          const previous = yield* inForce.current;
          const allowlist = yield* nextAllowlist(previous.egress);
          const providers = yield* nextProviders;
          const next = {
            egress: Option.getOrElse(allowlist.egress, () => previous.egress),
            providers: Option.getOrElse(providers, () => previous.providers),
          };
          yield* inForce.replace(next);
          if (Option.isSome(providers)) yield* reloadChatGptLogin(logins, next.providers);
          yield* Effect.logInfo("Reloaded the gateway settings", {
            environmentFiles: source.files,
            allowlist: Option.isSome(allowlist.egress) ? "reloaded" : "kept",
            path: allowlist.path,
            rules: next.egress.rules.length,
            providers: Option.isSome(providers) ? "reloaded" : "kept",
            changed: [
              ...changedVariables(
                credentialValues(previous.providers),
                credentialValues(next.providers),
              ),
              ...changedUpstreams(previous.providers, next.providers),
            ],
          });
        }).pipe(Effect.provideService(ConfigProvider.ConfigProvider, source.provider));

      const reload = Effect.fn("GatewayNode.reload")(function* () {
        yield* readSettingsSource(base).pipe(
          Effect.flatMap(reloadFrom),
          Effect.catchTags({
            EnvironmentFileError: ({ path, message }) =>
              Effect.logError("Kept the gateway settings: an environment file could not be read", {
                path,
                error: message,
              }),
            ConfigError: ({ message }) =>
              Effect.logError("Kept the gateway settings: the environment could not be read", {
                error: message,
              }),
          }),
        );
      });

      return {
        reload: oneAtATime
          .withPermits(1)(reload())
          .pipe(Effect.provideService(FileSystem.FileSystem, fileSystem)),
      };
    }),
  );

/**
 * Runs the reload on each SIGHUP while the layer is in scope, one at a time; signals during a
 * reload trigger one more. The listener also prevents Node's default exit on SIGHUP.
 */
export const reloadOnHangup = Layer.effectDiscard(
  Effect.gen(function* () {
    const { reload } = yield* GatewayReload;
    const hangups = yield* Queue.sliding<void>(1);
    const onHangup = () => {
      Queue.offerUnsafe(hangups, undefined);
    };
    yield* Effect.acquireRelease(
      Effect.sync(() => process.on("SIGHUP", onHangup)),
      () => Effect.sync(() => process.off("SIGHUP", onHangup)),
    );
    const reloadOnce = Effect.logInfo("Reloading the gateway settings on SIGHUP").pipe(
      Effect.andThen(reload),
      // Logs a defect in one reload; the next SIGHUP reloads again.
      Effect.catchCause((cause) =>
        Effect.logError("A reload failed", { cause: Cause.pretty(cause) }),
      ),
    );
    yield* Queue.take(hangups).pipe(Effect.andThen(reloadOnce), Effect.forever, Effect.forkScoped);
  }),
);
