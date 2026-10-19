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
import type { EgressAllowlist } from "../egress/egress.ts";
import type { LlmProviders } from "../llm/llm.ts";
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
 * Reads the gateway's settings again, from the same environment files and
 * allowlist file as at startup, and replaces the egress allowlist and the
 * LLM providers in force. The attachments, the admin API, the listeners, and
 * open tunnels are left as they are. `usine-gateway` runs it on SIGHUP.
 */
export class GatewayReload extends Context.Service<
  GatewayReload,
  {
    /**
     * Reloads once, after any reload already running. It does not fail: a
     * file that cannot be read or parsed keeps what is in force, a setting
     * that needs a restart is left as it is, and the log says which.
     */
    readonly reload: Effect.Effect<void>;
  }
>()("@usine/gateway/node/GatewayReload") {}

/** Each restart-only setting by its variable, as text to compare. */
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

/** Each credential variable with the value it sets, none when unset. */
const credentialValues = ({ anthropic, openai }: LlmProviders) => {
  const credential = Option.getOrUndefined(
    Option.map(anthropic, (provider) => provider.credential),
  );
  return {
    ANTHROPIC_API_KEY:
      credential?._tag === "AnthropicApiKey" ? Redacted.value(credential.key) : undefined,
    USINE_GATEWAY_ANTHROPIC_SUBSCRIPTION_TOKEN:
      credential?._tag === "AnthropicSubscriptionToken"
        ? Redacted.value(credential.token)
        : undefined,
    OPENAI_API_KEY: Option.getOrUndefined(
      Option.map(openai, (provider) => Redacted.value(provider.key)),
    ),
  };
};

/** The upstream variables whose values changed, for providers with a credential before and after. */
const changedUpstreams = (before: LlmProviders, after: LlmProviders): ReadonlyArray<string> => {
  const differs = (
    was: Option.Option<{ readonly upstream: string }>,
    is: Option.Option<{ readonly upstream: string }>,
  ) =>
    Option.getOrElse(
      Option.zipWith(was, is, (left, right) => left.upstream !== right.upstream),
      () => false,
    );
  return [
    ...(differs(before.anthropic, after.anthropic) ? ["USINE_GATEWAY_ANTHROPIC_UPSTREAM"] : []),
    ...(differs(before.openai, after.openai) ? ["USINE_GATEWAY_OPENAI_UPSTREAM"] : []),
  ];
};

/** The names of the variables whose values differ, never the values. */
const changedVariables = (
  before: Readonly<Record<string, string | undefined>>,
  after: Readonly<Record<string, string | undefined>>,
): ReadonlyArray<string> => Object.keys(before).filter((name) => before[name] !== after[name]);

/** Warns about restart-only settings that changed or no longer parse, since only a restart applies them. */
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

/** The allowlist file's path and what it now holds, or none when it cannot be read or parsed and the previous one stays. */
const nextAllowlist = (previous: EgressAllowlist) =>
  Effect.gen(function* () {
    // The path has a default, so reading it fails only when the settings source fails, and an in-memory source does not.
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

/** The LLM providers the settings now configure, or none when they are invalid and the previous ones stay. */
const nextProviders = llmProviders.pipe(
  Effect.map(Option.some),
  Effect.catchTags({
    ConfigError: ({ message }) => keptProviders(message),
    ConflictingAnthropicCredentials: ({ message }) => keptProviders(message),
  }),
);

/**
 * The reload for a gateway that started with `started`, reading its
 * settings from the environment files over `base` as at startup.
 */
export const gatewayReloadLayer = (started: StartupSettings, base: ConfigProvider.ConfigProvider) =>
  Layer.effect(
    GatewayReload,
    Effect.gen(function* () {
      const inForce = yield* SettingsInForce;
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
 * Runs the reload on every SIGHUP while the layer is in scope, one at a
 * time; signals that arrive during a reload lead to one more. The SIGHUP
 * listener also stops Node from exiting on SIGHUP, its default.
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
      // A defect in one reload is logged, and the next SIGHUP reloads again.
      Effect.catchCause((cause) =>
        Effect.logError("A reload failed", { cause: Cause.pretty(cause) }),
      ),
    );
    yield* Queue.take(hangups).pipe(Effect.andThen(reloadOnce), Effect.forever, Effect.forkScoped);
  }),
);
