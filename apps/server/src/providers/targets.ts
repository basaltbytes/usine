import { catalog } from "@usine/agents/harness";
import {
  anthropic,
  type GatewaySlot,
  type ModelProvider,
  ModelProviderCatalog,
  openai,
} from "@usine/core/agent/provider";
import { LoadedInstance } from "@usine/config/instance";
import {
  ConfigurationStore,
  configurationDiff,
  configurationEntities,
} from "@usine/config/configuration";
import { localActor } from "@usine/core/operator";
import type { ReleaseVersion } from "@usine/core/upgrade";
import { SshWorker, WorkerGateway, type Worker } from "@usine/config/factory";
import {
  Config,
  Context,
  Crypto,
  DateTime,
  Effect,
  FileSystem,
  Layer,
  Option,
  Redacted,
  Schema,
  Stream,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import {
  ProviderCredentialError,
  readAuthFile,
  ProviderConnections,
  ProviderCredential,
  providerEntry,
  type ProviderStatus,
  type ProviderTarget,
} from "@usine/gateway/credentials";

const quoteCurl = Schema.encodeEffect(Schema.fromJsonString(Schema.String));
const Json = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json));
const failed = (message: string) => ProviderCredentialError.make({ message });
const unreachableClaude = () =>
  failed(
    "Could not check or clear the local Claude login. Check Claude Code and its native credential store.",
  );
const localFailure = () =>
  failed("Could not read or save the local harness login. Check its directory permissions.");
/** The providers whose credentials the local Claude Code and Codex logins hold. */
const localProviders = ModelProviderCatalog.make({ providers: [anthropic, openai] });
/** Returns the provider that `credential` connects, by its ID or login, and its credential kind. */
const connecting = (credential: ProviderCredential) =>
  credential._tag === "StaticKey"
    ? { named: credential.provider, kind: "api-key" as const }
    : { named: credential.login, kind: "subscription" as const };
const makeProviderTargets = Effect.fn("ProviderTargets.make")(function* (
  workers: Effect.Effect<readonly Worker[]>,
  release: Option.Option<ReleaseVersion>,
) {
  const configuration = yield* ConfigurationStore;
  const fs = yield* FileSystem.FileSystem;
  const random = yield* Crypto.Crypto;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const home = yield* Config.String("HOME").pipe(Effect.orDie);
  const claudeHome = yield* Config.String("CLAUDE_CONFIG_DIR").pipe(
    Config.withDefault(`${home}/.claude`),
    Effect.orDie,
  );
  const codexHome = yield* Config.String("CODEX_HOME").pipe(
    Config.withDefault(`${home}/.codex`),
    Effect.orDie,
  );
  const path = yield* Config.String("PATH").pipe(
    Config.withDefault("/usr/local/bin:/usr/bin:/bin"),
    Effect.orDie,
  );
  const matchingRelease = Option.match(release, {
    onNone: () => "Install the @usine/gateway release that matches this orchestrator on it.",
    onSome: (version) => `Install @usine/gateway@${version} on it.`,
  });
  const olderGateway = (destination: string) =>
    failed(
      `Gateway ${destination} is older than this orchestrator: it has no provider-credentials admin API. ${matchingRelease}`,
    );
  const claudeCommand = Effect.fn("ProviderTargets.claudeCommand")(function* (
    action: "status" | "logout",
  ) {
    yield* Effect.annotateCurrentSpan({ target: "local", provider: anthropic.slot, action });
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const child = yield* spawner
          .spawn(
            ChildProcess.make(
              "claude",
              [
                "--setting-sources",
                "user",
                "auth",
                action,
                ...(action === "status" ? ["--json"] : []),
              ],
              {
                env: { HOME: home, PATH: path, CLAUDE_CONFIG_DIR: claudeHome },
                extendEnv: false,
                stdin: "ignore",
                stderr: "ignore",
                stdout: action === "status" ? "pipe" : "ignore",
              },
            ),
          )
          .pipe(
            Effect.mapError((error) =>
              error.reason._tag === "NotFound"
                ? failed("Claude Code not found on PATH. Install it to connect Claude.")
                : error,
            ),
          );
        const output = yield* Stream.mkString(Stream.decodeText(child.stdout));
        const exitCode = yield* child.exitCode;
        const exit = Number(exitCode);
        if (exit !== 0 && !(action === "status" && exit === 1))
          return yield* failed(
            "Claude authentication command failed. Check its native credential store.",
          );
        return output;
      }),
    ).pipe(
      Effect.timeout("30 seconds"),
      Effect.catchTags({
        PlatformError: () => unreachableClaude(),
        TimeoutError: () => unreachableClaude(),
      }),
      Effect.tapError((error) =>
        action === "status"
          ? Effect.void
          : Effect.logWarning("Local Claude authentication command failed", {
              action,
              message: error.message,
            }),
      ),
    );
  });
  const claudeStatus = Effect.gen(function* () {
    const output = yield* claudeCommand("status");
    return yield* Schema.decodeEffect(
      Schema.fromJsonString(
        Schema.Struct({
          loggedIn: Schema.Boolean,
          authMethod: Schema.String,
          apiProvider: Schema.String,
        }),
      ),
    )(output).pipe(Effect.mapError(() => failed("Claude returned an unrecognized login status.")));
  });
  const claudeFile = `${claudeHome}/settings.json`;
  const codexFile = `${codexHome}/auth.json`;
  const read = (file: string) =>
    Effect.gen(function* () {
      if (!(yield* fs.exists(file))) return {};
      return yield* fs.readFileString(file).pipe(Effect.flatMap(Schema.decodeEffect(Json)));
    }).pipe(Effect.mapError(localFailure));
  const write = (directory: string, file: string, value: Readonly<Record<string, Schema.Json>>) =>
    Effect.gen(function* () {
      const uuid = yield* random.randomUUIDv4().pipe(Effect.orDie);
      const temporary = `${file}.usine-${uuid}`;
      const text = yield* Schema.encodeEffect(Json)(value).pipe(Effect.orDie);
      yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
      yield* fs.writeFileString(temporary, text, { mode: 0o600, flag: "wx" });
      yield* fs.rename(temporary, file);
    }).pipe(Effect.mapError(localFailure));
  const environment = (settings: Readonly<Record<string, Schema.Json>>) =>
    Schema.decodeUnknownEffect(Schema.Record(Schema.String, Schema.String))(
      settings.env ?? {},
    ).pipe(Effect.mapError(localFailure));
  const gateways = Effect.map(workers, (all) => {
    const unique = new Map<string, WorkerGateway>();
    for (const worker of all)
      if (worker.kind === "ssh" && Option.isSome(worker.gateway))
        unique.set(worker.gateway.value.destination, worker.gateway.value);
    return unique;
  });
  const remote = Effect.fn("ProviderTargets.gateway")(
    function* (
      gateway: WorkerGateway,
      method: "GET" | "PUT" | "DELETE",
      provider: string,
      credential?: ProviderCredential,
    ) {
      yield* Effect.annotateCurrentSpan({ gateway: gateway.destination, method, provider });
      const token = yield* Config.Redacted(gateway.adminTokenEnv).pipe(
        Effect.mapError(() => failed(`Set ${gateway.adminTokenEnv} to the gateway admin token.`)),
      );
      const payload =
        credential === undefined
          ? undefined
          : yield* Schema.encodeEffect(
              Schema.fromJsonString(Schema.toCodecJson(ProviderCredential)),
            )(credential).pipe(Effect.orDie);
      const authorization = yield* quoteCurl(`Authorization: Bearer ${Redacted.value(token)}`).pipe(
        Effect.orDie,
      );
      const data = payload === undefined ? undefined : yield* quoteCurl(payload).pipe(Effect.orDie);
      const config = [
        `url = "http://127.0.0.1:${gateway.adminPort}/v1/provider-credentials${method === "DELETE" ? `/${provider}` : ""}"`,
        `request = "${method}"`,
        // The status follows the body on its own line, also when --fail suppresses the body.
        'write-out = "\\n%{http_code}"',
        `header = ${authorization}`,
        'header = "Content-Type: application/json"',
        ...(payload === undefined ? [] : [`data = ${data}`]),
      ].join("\n");
      const child = yield* spawner
        .spawn(
          ChildProcess.make(
            "ssh",
            [
              "-o",
              "BatchMode=yes",
              "-o",
              "ConnectTimeout=10",
              "--",
              gateway.destination,
              "curl --silent --fail --max-time 25 --config -",
            ],
            {
              stdin: Stream.make(new TextEncoder().encode(config)),
              stderr: "ignore",
            },
          ),
        )
        .pipe(Effect.mapError(() => failed("Could not reach the gateway admin API over SSH.")));
      const output = yield* Stream.mkString(Stream.decodeText(child.stdout)).pipe(
        Effect.mapError(() => failed("The gateway did not return a connection state.")),
      );
      const exit = yield* child.exitCode.pipe(
        Effect.mapError(() => failed("The gateway request failed.")),
      );
      const statusLine = output.lastIndexOf("\n");
      const status = output.slice(statusLine + 1);
      if (Number(exit) !== 0)
        return yield* status === "404"
          ? olderGateway(gateway.destination)
          : status === "422"
            ? failed(`Gateway ${gateway.destination} doesn't serve ${provider}. ${matchingRelease}`)
            : failed(
                "The gateway refused the credential request. Check its version, admin token, and service logs.",
              );
      return output.slice(0, Math.max(statusLine, 0));
    },
    Effect.timeoutOrElse({
      duration: "35 seconds",
      orElse: () =>
        failed(
          "The gateway credential request timed out. Check SSH access and gateway service logs.",
        ),
    }),
  );
  const claudeConnection = Effect.gen(function* () {
    const claude = yield* claudeStatus;
    const nativeClaude = yield* read(`${claudeHome}/.credentials.json`);
    const claudeLogin = Schema.decodeUnknownOption(
      Schema.Struct({
        accessToken: Schema.NonEmptyString,
        expiresAt: Schema.optionalKey(Schema.Finite),
      }),
    )(nativeClaude.claudeAiOauth);
    const connection = {
      provider: anthropic.slot,
      ...providerEntry(anthropic),
      credential:
        !claude.loggedIn || claude.apiProvider !== "firstParty"
          ? null
          : claude.authMethod === "api_key"
            ? ("api-key" as const)
            : ["claude.ai", "oauth_token"].includes(claude.authMethod)
              ? ("subscription" as const)
              : null,
      expiresAt:
        claude.loggedIn &&
        claude.authMethod === "claude.ai" &&
        Option.isSome(claudeLogin) &&
        claudeLogin.value.expiresAt !== undefined
          ? Option.getOrNull(
              Option.map(DateTime.make(claudeLogin.value.expiresAt), DateTime.formatIso),
            )
          : null,
      lastRefresh: null,
    };
    if (connection.credential === "subscription" && claude.authMethod === "oauth_token")
      return { ...connection, refreshable: false };
    return connection;
  });
  const codexConnection = Effect.gen(function* () {
    const exit = yield* spawner
      .exitCode(
        ChildProcess.make("codex", ["--version"], {
          env: { HOME: home, PATH: path, CODEX_HOME: codexHome },
          extendEnv: false,
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
        }),
      )
      .pipe(
        Effect.timeout("30 seconds"),
        Effect.catchTags({
          PlatformError: (error) =>
            failed(
              error.reason._tag === "NotFound"
                ? "Codex not found on PATH. Install it to connect ChatGPT."
                : "Could not run Codex. Check its installation and try again.",
            ),
          TimeoutError: () =>
            failed("Codex did not respond. Check its installation and try again."),
        }),
      );
    if (Number(exit) !== 0)
      return yield* failed("Could not run Codex. Check its installation and try again.");
    const codex = yield* read(codexFile);
    const tokenFields = Schema.decodeUnknownOption(
      Schema.Struct({
        last_refresh: Schema.optionalKey(Schema.String),
        tokens: Schema.Struct({ access_token: Schema.String }),
      }),
    )(codex);
    const codexTokens = Option.isSome(tokenFields)
      ? yield* readAuthFile(codexFile).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.mapError(localFailure),
          Effect.asSome,
        )
      : Option.none();
    return {
      provider: openai.slot,
      ...providerEntry(openai),
      credential: Option.isSome(tokenFields)
        ? ("subscription" as const)
        : Option.isSome(Schema.decodeUnknownOption(Schema.NonEmptyString)(codex.OPENAI_API_KEY))
          ? ("api-key" as const)
          : null,
      expiresAt: Option.getOrNull(
        Option.flatMap(codexTokens, (tokens) => Option.map(tokens.expiresAt, DateTime.formatIso)),
      ),
      lastRefresh: Option.isSome(tokenFields) ? (tokenFields.value.last_refresh ?? null) : null,
    };
  });
  const statusErrors = new Map<string, string>();
  const isolated = <A>(
    provider: ModelProvider,
    connection: Effect.Effect<A, ProviderCredentialError>,
  ) =>
    connection.pipe(
      Effect.tap(() =>
        Effect.gen(function* () {
          if (statusErrors.delete(provider.slot))
            yield* Effect.logInfo("Local provider status available", { provider: provider.slot });
        }),
      ),
      Effect.catchTag("ProviderCredentialError", (error) =>
        Effect.gen(function* () {
          if (statusErrors.get(provider.slot) !== error.message) {
            statusErrors.set(provider.slot, error.message);
            yield* Effect.logInfo("Local provider status unavailable", {
              provider: provider.slot,
              message: error.message,
            });
          }
          return { provider: provider.slot, ...providerEntry(provider), error: error.message };
        }),
      ),
    );
  const localStatus = Effect.all(
    [isolated(anthropic, claudeConnection), isolated(openai, codexConnection)],
    { concurrency: "unbounded" },
  );
  const replaceLocal = (credential: ProviderCredential) =>
    Effect.gen(function* () {
      const provider = credential.providerIn(localProviders);
      if (Option.isNone(provider))
        return yield* failed(
          `Connect ${connecting(credential).named} on a gateway: without one, usine connects only the providers of the local Claude Code and Codex.`,
        );
      if (provider.value.slot === anthropic.slot) {
        const settings = yield* read(claudeFile);
        const configured = yield* environment(settings);
        const env = { ...configured };
        delete env.ANTHROPIC_API_KEY;
        delete env.CLAUDE_CODE_OAUTH_TOKEN;
        env[credential._tag === "LoginSecret" ? "CLAUDE_CODE_OAUTH_TOKEN" : "ANTHROPIC_API_KEY"] =
          Redacted.value(credential.secret);
        return yield* write(claudeHome, claudeFile, { ...settings, env });
      }
      const data =
        credential._tag === "LoginSecret"
          ? yield* Schema.decodeEffect(Json)(Redacted.value(credential.secret)).pipe(
              Effect.mapError(localFailure),
            )
          : { OPENAI_API_KEY: Redacted.value(credential.secret) };
      yield* write(codexHome, codexFile, data);
    });
  const selected = (target: string) =>
    Effect.gen(function* () {
      const gateway = (yield* gateways).get(target);
      if (gateway === undefined)
        return yield* failed("This gateway is no longer configured. Refresh the page.");
      return gateway;
    });
  /**
   * Routes the gateway's workers to the slot of `used`, or away from it. Configuration lists only the
   * slots of providers that this orchestrator's harnesses use, so routing skips any other provider.
   */
  const routeWorkers = Effect.fn("ProviderTargets.routeWorkers")(
    function* (
      target: string,
      named: string,
      used: Option.Option<ModelProvider>,
      action: "connect" | "disconnect",
    ) {
      yield* Effect.annotateCurrentSpan({ target, provider: named, action });
      if (Option.isNone(used))
        return yield* Effect.logInfo(
          "Kept the worker routing: no harness of this orchestrator uses the provider",
          { target, provider: named, action },
        );
      const provider = used.value.slot;
      const snapshot = yield* configuration.read;
      if (Option.isNone(snapshot.instance)) return;
      const instance = snapshot.instance.value;
      const workers = instance.config.workers.map((worker) => {
        if (
          worker.kind !== "ssh" ||
          Option.isNone(worker.gateway) ||
          worker.gateway.value.destination !== target
        )
          return worker;
        const gateway = worker.gateway.value;
        const llmProviders =
          action === "connect"
            ? [...new Set([...gateway.llmProviders, provider])]
            : gateway.llmProviders.filter((value) => value !== provider);
        return SshWorker.make({
          ...worker,
          gateway: Option.some(WorkerGateway.make({ ...gateway, llmProviders })),
        });
      });
      const next = LoadedInstance.make({ ...instance, config: { ...instance.config, workers } });
      const changes = configurationDiff(
        configurationEntities(instance),
        configurationEntities(next),
      );
      if (changes.length === 0) return;
      const revision = yield* configuration.commit({
        expected: snapshot.number,
        changes,
        actor: Option.some(localActor),
        message: Option.some(
          `${action === "connect" ? "Connected" : "Disconnected"} ${provider} on ${target}`,
        ),
      });
      yield* Effect.logInfo("Gateway provider routing updated", {
        target,
        provider,
        action,
        revision: revision.number,
      });
    },
    Effect.mapError(() =>
      failed(
        "The credential changed, but worker routing could not be saved. Try the connection action again.",
      ),
    ),
  );
  const get = Effect.fn("ProviderTargets.get")(function* (target: string) {
    yield* Effect.annotateCurrentSpan({ target });
    if (target === "local") {
      if ((yield* gateways).size > 0)
        return yield* failed("Choose the configured gateway for this instance.");
      return { target, label: "Local harnesses", providers: yield* localStatus };
    }
    const gateway = yield* selected(target);
    const text = yield* Effect.scoped(remote(gateway, "GET", ""));
    const reported = yield* Schema.decodeEffect(Schema.fromJsonString(ProviderConnections))(
      text,
    ).pipe(Effect.mapError(() => failed("Upgrade the gateway to enable provider connections.")));
    // A gateway up to 0.3.0 reports only the state; this orchestrator's catalog describes its providers.
    const providers = reported.providers.flatMap((connection) =>
      "id" in connection
        ? [connection]
        : Option.toArray(catalog.providers.find(connection.provider)).map((provider) => ({
            ...connection,
            ...providerEntry(provider),
          })),
    );
    if (providers.length < reported.providers.length)
      yield* Effect.logDebug(
        "Left out the slots that the gateway and this orchestrator don't describe",
        {
          target,
          slots: reported.providers
            .filter(
              (connection) => !providers.some(({ provider }) => provider === connection.provider),
            )
            .map(({ provider }) => provider)
            .join(","),
        },
      );
    return { target, label: gateway.destination, providers };
  });
  // Settings polls the list, so each destination's error is logged when it changes.
  const destinationErrors = new Map<string, string>();
  return {
    get,
    list: Effect.gen(function* () {
      const configured = yield* gateways;
      const targets = configured.size === 0 ? ["local"] : [...configured.keys()];
      return yield* Effect.forEach(
        targets,
        (target) =>
          get(target).pipe(
            Effect.tap(() =>
              destinationErrors.delete(target)
                ? Effect.logInfo("Provider destination status available", { target })
                : Effect.void,
            ),
            Effect.catchTag("ProviderCredentialError", (error) =>
              Effect.gen(function* () {
                if (destinationErrors.get(target) !== error.message) {
                  destinationErrors.set(target, error.message);
                  yield* Effect.logWarning("Provider destination status unavailable", {
                    target,
                    message: error.message,
                  });
                }
                return {
                  target,
                  label: target === "local" ? "Local harnesses" : target,
                  error: error.message,
                };
              }),
            ),
          ),
        { concurrency: "unbounded" },
      );
    }).pipe(Effect.withSpan("ProviderTargets.list")),
    replace: Effect.fn("ProviderTargets.replace")(function* (
      target: string,
      credential: ProviderCredential,
    ) {
      const { named, kind } = connecting(credential);
      yield* Effect.annotateCurrentSpan({ target, provider: named, kind });
      if (target === "local") {
        if ((yield* gateways).size > 0)
          return yield* failed("Choose the configured gateway for this instance.");
        yield* replaceLocal(credential);
      } else {
        const gateway = yield* selected(target);
        yield* Effect.scoped(remote(gateway, "PUT", named, credential));
        yield* routeWorkers(target, named, credential.providerIn(catalog.providers), "connect");
      }
      yield* Effect.logInfo("Provider connected", { target, provider: named, kind });
    }),
    disconnect: Effect.fn("ProviderTargets.disconnect")(function* (
      target: string,
      provider: GatewaySlot,
    ) {
      yield* Effect.annotateCurrentSpan({ target, provider });
      if (target === "local" && (yield* gateways).size > 0)
        return yield* failed("Choose the configured gateway for this instance.");
      if (target !== "local") {
        const gateway = yield* selected(target);
        yield* Effect.scoped(remote(gateway, "DELETE", provider));
        yield* routeWorkers(target, provider, catalog.providers.find(provider), "disconnect");
      } else if (provider === openai.slot)
        yield* fs.remove(codexFile, { force: true }).pipe(Effect.mapError(localFailure));
      else if (provider !== anthropic.slot)
        return yield* failed(
          `Disconnect ${provider} on a gateway: without one, usine connects only the providers of the local Claude Code and Codex.`,
        );
      else {
        yield* claudeCommand("logout");
        const settings = yield* read(claudeFile);
        const configured = yield* environment(settings);
        const env = { ...configured };
        delete env.ANTHROPIC_API_KEY;
        delete env.CLAUDE_CODE_OAUTH_TOKEN;
        yield* write(claudeHome, claudeFile, { ...settings, env });
        yield* fs
          .remove(`${claudeHome}/.credentials.json`, { force: true })
          .pipe(Effect.mapError(localFailure));
        const status = yield* claudeStatus;
        if (status.loggedIn)
          return yield* failed(
            "Claude is still signed in. Clear its native credential store and retry disconnect.",
          );
      }
      yield* Effect.logInfo("Provider disconnected", { target, provider });
    }),
  };
});

export class ProviderTargets extends Context.Service<
  ProviderTargets,
  {
    readonly list: Effect.Effect<ProviderStatus["targets"], ProviderCredentialError>;
    readonly get: (target: string) => Effect.Effect<ProviderTarget, ProviderCredentialError>;
    readonly replace: (
      target: string,
      credential: ProviderCredential,
    ) => Effect.Effect<void, ProviderCredentialError>;
    readonly disconnect: (
      target: string,
      provider: GatewaySlot,
    ) => Effect.Effect<void, ProviderCredentialError>;
  }
>()("@usine/server/providers/targets/ProviderTargets") {
  /**
   * Returns the provider targets of `workers`. `release` is the `@usine/gateway` release that an
   * older gateway is told to install, or `None` when this server isn't a published release.
   */
  static readonly layer = (
    workers: Effect.Effect<readonly Worker[]>,
    release: Option.Option<ReleaseVersion>,
  ) => Layer.effect(ProviderTargets, makeProviderTargets(workers, release));
}
