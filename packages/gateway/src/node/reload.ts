import { ProviderCredentials } from "../credentials/store.ts";
import {
  Crypto,
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
import type { ModelProviderCatalog } from "@usine/core/agent/provider";
import { type LlmProviders, upstreamVariable } from "../llm/llm.ts";
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
>()("@usine/gateway/node/reload/GatewayReload") {}

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

/** Returns each credential variable of `catalog` with its value, or `undefined` if unset. */
const credentialValues = (catalog: ModelProviderCatalog, providers: LlmProviders) =>
  Object.fromEntries(
    catalog.providers.flatMap((provider) => {
      const held = providers[provider.slot]?.credential;
      const value =
        held === undefined
          ? undefined
          : held._tag === "ApiKey"
            ? Redacted.value(held.key)
            : held._tag === "AnthropicSubscriptionToken"
              ? Redacted.value(held.token)
              : held.authFile;
      const set = held?._tag === "ApiKey" ? "ApiKey" : "Subscription";
      return provider.credentials.map(
        ({ _tag, variable }) => [variable, _tag === set ? value : undefined] as const,
      );
    }),
  );

/** Returns the upstream variables that changed, for providers with the same kind of credential before and after. */
const changedUpstreams = (
  catalog: ModelProviderCatalog,
  before: LlmProviders,
  after: LlmProviders,
): ReadonlyArray<string> =>
  catalog.providers.flatMap((provider) => {
    const was = before[provider.slot];
    const is = after[provider.slot];
    if (was === undefined || is === undefined) return [];
    return was.credential._tag === is.credential._tag &&
      Option.getOrNull(was.upstream) !== Option.getOrNull(is.upstream)
      ? Option.toArray(upstreamVariable(provider, is))
      : [];
  });

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
const nextProviders = (catalog: ModelProviderCatalog) =>
  llmProviders(catalog).pipe(
    Effect.asSome,
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
const reloadChatGptLogins = (logins: ChatGptLogins["Service"], providers: LlmProviders) =>
  Effect.forEach(
    Object.values(providers).flatMap(({ credential }) =>
      credential._tag === "ChatGptLogin" ? [credential] : [],
    ),
    (login) =>
      logins.reload(login).pipe(
        Effect.catchTag("ChatGptAuthFileError", ({ message }) =>
          Effect.logError("Kept the ChatGPT login in memory: its auth file could not be read", {
            authFile: login.authFile,
            error: message,
          }),
        ),
      ),
    { discard: true },
  );

/** Returns the reload for a Gateway started with `started`, reading settings from the environment files over `base`. */
export const gatewayReloadLayer = (started: StartupSettings, base: ConfigProvider.ConfigProvider) =>
  Layer.effect(
    GatewayReload,
    Effect.gen(function* () {
      const inForce = yield* SettingsInForce;
      const logins = yield* ChatGptLogins;
      const fileSystem = yield* FileSystem.FileSystem;
      const crypto = yield* Crypto.Crypto;
      const credentials = yield* Effect.serviceOption(ProviderCredentials);
      const oneAtATime = yield* Semaphore.make(1);
      const { domain, adminToken, callerKey, catalog } = started.settings;
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
          const providers = yield* nextProviders(catalog);
          const next = {
            egress: Option.getOrElse(allowlist.egress, () => previous.egress),
            providers: yield* Option.match(credentials, {
              onNone: () => Effect.succeed(Option.getOrElse(providers, () => previous.providers)),
              onSome: (store) => store.apply(Option.getOrElse(providers, () => previous.providers)),
            }),
          };
          yield* inForce.replace(next);
          if (Option.isSome(providers)) yield* reloadChatGptLogins(logins, next.providers);
          yield* Effect.logInfo("Reloaded the gateway settings", {
            environmentFiles: source.files,
            allowlist: Option.isSome(allowlist.egress) ? "reloaded" : "kept",
            path: allowlist.path,
            rules: next.egress.rules.length,
            providers: Option.isSome(providers) ? "reloaded" : "kept",
            changed: [
              ...changedVariables(
                credentialValues(catalog, previous.providers),
                credentialValues(catalog, next.providers),
              ),
              ...changedUpstreams(catalog, previous.providers, next.providers),
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
          .pipe(
            Effect.provideService(FileSystem.FileSystem, fileSystem),
            Effect.provideService(Crypto.Crypto, crypto),
          ),
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
