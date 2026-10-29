import { Authentication, authenticationLayer, seedOperator } from "./auth/authentication.ts";
import { GitHubSignIn, githubSignInLayer } from "./auth/github.ts";
import { AuthStore } from "./auth/store.ts";
import { sqliteAuthLayer } from "./auth/sqlite.ts";
import { writeAdminToken } from "./auth/local.ts";
import type { AuthServices } from "./auth/http.ts";
import { FetchHttpClient } from "effect/http";
import { ItemProjectionReader } from "@usine/engine/item-projection";
import { MarcbachmannCelLayer } from "@usine/expression/marcbachmann-cel";
import { GitHubPolling } from "@usine/github/polling";
import { ServerUpgrades } from "./upgrade/control.ts";
import { systemUpgradePlatform } from "./upgrade/platform.ts";
import { localSqliteLayer } from "@usine/engine/local-sqlite";
import type { RunDatabase } from "@usine/engine/database";
import type { EnginePersistenceError } from "@usine/engine/engine";
import { configurationLayer, initializeConfiguration } from "./configuration/runtime.ts";
import { AttentionAcknowledgements } from "@usine/engine/attention";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { NodeServices } from "@effect/platform-node";
import { InstanceDirectory, type InstanceId } from "@usine/core/instance";
import { RunEngine, RunEngineShutdown } from "@usine/engine/engine";
import { GitHubApp, GitHubCredentials } from "@usine/github/github-app";
import { loadLocalCredentials } from "@usine/github/local-secrets";
import { CurrentInstance } from "@usine/orchestrator/current-instance";
import {
  ConfigurationEditor,
  Operator,
  OperatorConfiguration,
  OperatorObservation,
} from "@usine/orchestrator/operator";
import { Orchestrator } from "@usine/orchestrator/orchestrator";
import { operatorObservationLayer, runtimeLayer } from "@usine/orchestrator/runtime";
import {
  Cause,
  Config,
  Console,
  Context,
  DateTime,
  Duration,
  Deferred,
  Effect,
  FileSystem,
  Layer,
  Option,
  References,
  Result,
} from "effect";
import { liveBackendLayer, needsSetupBackendLayer } from "./backend.ts";
import {
  type Port,
  type UiOrigin,
  type UpCommand,
  VolatileInstanceDirectoryError,
  openBrowser,
  packageVersion,
  portInUse,
  refuseTakenPort,
  serverStartError,
  volatileRoot,
  volatileRoots,
} from "./cli.ts";
import { serverLayer } from "./http.ts";
import { instanceIdOf } from "./instance/id.ts";
import { holdInstance } from "./instance/lock.ts";
import { InstanceRecord, ProcessId, currentLaunch, instanceFiles } from "./instance/record.ts";
import { currentSystemService } from "./instance/systemd.ts";
import { reloadOnHangup } from "./reload-signal.ts";
import { withGracefulShutdown } from "./shutdown.ts";
import { warnIfSystemSleeps } from "./system-sleep.ts";
import { tracingLayer } from "./tracing.ts";

// Untraced: a span around a server that never returns would parent every request span.
const serve = Effect.fnUntraced(function* (options: {
  readonly auth: AuthServices;
  readonly backend: ReturnType<typeof liveBackendLayer>;
  readonly webRoot: string;
  readonly port: Port;
  readonly origin: Option.Option<UiOrigin>;
  readonly url: string;
  readonly openSetupPage: boolean;
  readonly upgrades: ServerUpgrades["Service"];
  readonly configurationEditor: ConfigurationEditor["Service"];
  readonly catalog?: Layer.Layer<GitHubApp | GitHubPolling>;
}) {
  yield* Layer.build(
    serverLayer(
      options.backend,
      options.webRoot,
      options.port,
      options.origin,
      options.auth,
      Layer.mergeAll(
        options.catalog ?? Layer.empty,
        Layer.succeed(ServerUpgrades, options.upgrades),
        Layer.succeed(ConfigurationEditor, options.configurationEditor),
      ),
    ),
  ).pipe(
    Effect.mapError((error) => serverStartError(options.port, error)),
    Effect.catchTag("PortInUseError", ({ port }) => portInUse(port)),
  );
  yield* options.upgrades.polling.pipe(Effect.forkScoped);
  yield* Console.log(
    options.openSetupPage
      ? `usine is running in setup mode at ${options.url}`
      : `usine is running at ${options.url}`,
  );
  const signInLink = yield* options.auth.authentication.link;
  yield* Console.log(`Sign in: ${signInLink}`);
  if (options.openSetupPage) {
    yield* openBrowser(signInLink).pipe(
      Effect.tapError((error) =>
        Effect.logWarning("The setup page could not be opened automatically", {
          command: error.command,
          cause: error.cause,
          url: options.url,
        }),
      ),
      Effect.ignore,
    );
  }
  return yield* Effect.never;
});

const refuseVolatileInstance = Effect.fn("Server.refuseVolatileInstance")(function* (
  directory: InstanceDirectory,
  allowVolatileInstance: boolean,
) {
  const realDirectory = yield* Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
    fileSystem.realPath(directory),
  ).pipe(Effect.orElseSucceed(() => directory));
  const roots = volatileRoots(yield* Effect.orDie(Config.option(Config.String("TMPDIR"))));
  const root = Option.orElse(volatileRoot(directory, roots), () =>
    volatileRoot(realDirectory, roots),
  );
  if (Option.isNone(root)) return;
  if (!allowVolatileInstance) {
    return yield* new VolatileInstanceDirectoryError({ directory, root: root.value });
  }
  yield* Effect.logWarning(
    "Instance folder sits under a volatile path; its runtime store is the only copy of run history",
    { instanceDirectory: directory, root: root.value },
  );
});

/** Serves setup mode if the GitHub App credentials are absent, otherwise runs the factory. */
const start = Effect.fnUntraced(function* (
  directory: InstanceDirectory,
  instanceId: InstanceId,
  instances: CurrentInstance["Service"],
  port: Port,
  origin: Option.Option<UiOrigin>,
  record: InstanceRecord,
  database: Layer.Layer<RunDatabase, EnginePersistenceError>,
  configurationEditor: ConfigurationEditor["Service"],
  auth: AuthServices,
) {
  yield* reloadOnHangup(instances);
  const credentials = yield* loadLocalCredentials(directory).pipe(
    Effect.provide(NodeServices.layer),
    Effect.result,
  );
  const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "web");
  const url = `http://127.0.0.1:${port}`;

  if (Result.isFailure(credentials)) {
    const error = credentials.failure;
    yield* Effect.logWarning("GitHub App credentials are absent; pollers are idle", {
      errorTag: error._tag,
      message: error.message,
      instanceDirectory: directory,
    });
    const observationContext = yield* Layer.build(operatorObservationLayer(directory, database));
    const backend = needsSetupBackendLayer(
      instances,
      error._tag,
      Context.get(observationContext, OperatorObservation),
      Context.get(observationContext, OperatorConfiguration),
      Context.get(observationContext, AttentionAcknowledgements),
    );
    const upgradeContext = yield* Layer.build(
      ServerUpgrades.layer({
        running: record.version,
        settings: Effect.map(instances.get, ({ config }) => config.settings),
        platform: Option.none(),
        drain: Effect.void,
      }),
    );
    return yield* serve({
      auth,
      backend,
      configurationEditor,
      webRoot,
      port,
      origin,
      url,
      openSetupPage: true,
      upgrades: Context.get(upgradeContext, ServerUpgrades),
    });
  }

  const shutdown = yield* Deferred.make<void>();
  const startup = Effect.gen(function* () {
    const runtime = runtimeLayer(directory, instanceId, database).pipe(
      Layer.provide(Layer.succeed(GitHubCredentials, credentials.success)),
      Layer.provide(Layer.succeed(CurrentInstance, instances)),
    );
    const context = yield* Layer.build(runtime).pipe(
      Effect.provideService(RunEngineShutdown, shutdown),
    );
    const operator = Context.get(context, Operator);
    const orchestrator = Context.get(context, Orchestrator);
    const engine = Context.get(context, RunEngine);
    const upgradeContext = yield* Layer.build(
      ServerUpgrades.layer({
        running: record.version,
        settings: Effect.map(instances.get, ({ config }) => config.settings),
        platform: yield* systemUpgradePlatform(directory, record).pipe(
          Effect.provide(NodeServices.layer),
        ),
        drain: engine.drain(),
      }),
    );
    const upgrades = Context.get(upgradeContext, ServerUpgrades);
    return {
      drain: engine.drain(),
      running: Effect.raceFirst(
        serve({
          auth,
          backend: liveBackendLayer(
            instances,
            operator,
            Context.get(context, OperatorConfiguration),
          ),
          configurationEditor,
          catalog: Layer.merge(
            Layer.succeed(GitHubApp, Context.get(context, GitHubApp)),
            Layer.succeed(GitHubPolling, Context.get(context, GitHubPolling)),
          ),
          webRoot,
          port,
          origin,
          url,
          openSetupPage: false,
          upgrades,
        }),
        orchestrator.run.pipe(
          Effect.tapCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.void
              : Effect.logFatal("Trigger streams stopped; shutting the server down", {
                  cause,
                }),
          ),
        ),
      ),
    };
  });
  return yield* withGracefulShutdown(
    startup,
    shutdown,
    Effect.map(instances.get, ({ config }) =>
      Option.match(config.settings.maxAttemptMinutes, {
        onNone: () => Duration.infinity,
        onSome: Duration.minutes,
      }),
    ),
  );
});

export const up = (command: UpCommand) =>
  Effect.scoped(
    Effect.gen(function* () {
      const { port, origin } = command;
      const directory = InstanceDirectory.make(process.cwd());
      yield* refuseVolatileInstance(directory, command.allowVolatileInstance).pipe(
        Effect.provide(NodeServices.layer),
      );
      const record = new InstanceRecord({
        pid: ProcessId.make(process.pid),
        version: yield* packageVersion().pipe(Effect.provide(NodeServices.layer)),
        startedAt: yield* DateTime.now,
        launch: yield* currentLaunch(command),
        systemdUnit: yield* currentSystemService().pipe(Effect.provide(NodeServices.layer)),
      });
      // Acquired before any store opens and released after every store closes.
      yield* holdInstance(directory, record).pipe(Effect.provide(NodeServices.layer));
      const instanceId = yield* instanceIdOf(instanceFiles(directory)).pipe(
        Effect.provide(NodeServices.layer),
      );
      yield* refuseTakenPort(port).pipe(Effect.provide(NodeServices.layer));
      if (process.platform === "darwin")
        yield* warnIfSystemSleeps().pipe(Effect.provide(NodeServices.layer));
      const databaseContext = yield* Layer.build(localSqliteLayer(directory));
      const database = Layer.succeedContext(databaseContext);
      const configurationContext = yield* Layer.build(
        configurationLayer.pipe(Layer.provide(database)),
      );
      const initial = yield* initializeConfiguration(directory).pipe(
        Effect.provideContext(configurationContext),
      );
      const current = yield* Layer.build(
        CurrentInstance.layer(directory, initial.instance, initial.number).pipe(
          Layer.provide(Layer.succeedContext(configurationContext)),
        ),
      );
      const instances = Context.get(current, CurrentInstance);
      const editorContext = yield* Layer.build(
        ConfigurationEditor.layer.pipe(
          Layer.provide(ItemProjectionReader.layer.pipe(Layer.provide(database))),
          Layer.provide(MarcbachmannCelLayer),
          Layer.provide(Layer.succeed(CurrentInstance, instances)),
          Layer.provide(Layer.succeedContext(configurationContext)),
        ),
      );
      const configurationEditor = Context.get(editorContext, ConfigurationEditor);
      const { config } = yield* instances.get;
      const authStoreContext = yield* Layer.build(sqliteAuthLayer.pipe(Layer.provide(database)));
      const githubContext = yield* Layer.build(
        githubSignInLayer.pipe(Layer.provide(FetchHttpClient.layer)),
      );
      const authDependencies = Layer.mergeAll(
        Layer.succeedContext(authStoreContext),
        Layer.succeedContext(githubContext),
      );
      yield* seedOperator(config.operator).pipe(Effect.provide(authDependencies));
      const localToken = yield* writeAdminToken(directory).pipe(Effect.provide(NodeServices.layer));
      const authContext = yield* Layer.build(
        authenticationLayer({
          origin: Option.getOrElse(origin, () => `http://127.0.0.1:${port}`),
          localToken,
        }).pipe(Layer.provide(authDependencies)),
      );
      const auth = {
        authentication: Context.get(authContext, Authentication),
        store: Context.get(authStoreContext, AuthStore),
        github: Context.get(githubContext, GitHubSignIn),
      };
      // Built before the runtime, so the exporter flushes the runtime's last spans when it closes.
      const tracer = yield* Layer.build(tracingLayer(config.tracing)).pipe(
        Effect.provide(NodeServices.layer),
      );
      return yield* start(
        directory,
        instanceId,
        instances,
        port,
        origin,
        record,
        database,
        configurationEditor,
        auth,
      ).pipe(Effect.provideContext(tracer), Effect.provideContext(configurationContext));
    }),
  ).pipe(Effect.provideService(References.MinimumLogLevel, command.logLevel));
