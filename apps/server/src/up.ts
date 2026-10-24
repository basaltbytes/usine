import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { NodeServices } from "@effect/platform-node";
import { InstanceFolder } from "@usine/config/instance-folder";
import { ConfigParser } from "@usine/config/parser";
import { InstanceDirectory } from "@usine/core/instance";
import { RunEngine, RunEngineShutdown } from "@usine/engine/engine";
import { MarcbachmannCelLayer } from "@usine/expression/marcbachmann-cel";
import { GitHubCredentials } from "@usine/github/github-app";
import { loadLocalCredentials } from "@usine/github/local-secrets";
import { CurrentInstance } from "@usine/orchestrator/current-instance";
import { Operator, OperatorConfiguration, OperatorObservation } from "@usine/orchestrator/operator";
import { Orchestrator } from "@usine/orchestrator/orchestrator";
import { operatorObservationLayer, runtimeLayer } from "@usine/orchestrator/runtime";
import {
  Cause,
  Console,
  Context,
  Duration,
  Deferred,
  Effect,
  FileSystem,
  Layer,
  Option,
  Result,
} from "effect";
import { liveBackendLayer, needsSetupBackendLayer } from "./backend.ts";
import {
  type Port,
  VolatileInstanceDirectoryError,
  openBrowser,
  portInUse,
  refuseTakenPort,
  serverStartError,
  volatileRoot,
  volatileRoots,
} from "./cli.ts";
import { serverLayer } from "./http.ts";
import { holdInstance } from "./instance-lock.ts";
import { reloadOnHangup } from "./reload-signal.ts";
import { withGracefulShutdown } from "./shutdown.ts";
import { tracingLayer } from "./tracing.ts";

const instanceFolderLayer = InstanceFolder.layer.pipe(
  Layer.provide(ConfigParser.layer.pipe(Layer.provide(MarcbachmannCelLayer))),
  Layer.provide(NodeServices.layer),
);

/** Loads the instance folder and keeps it reloadable. Fails if `usine.yaml` is invalid. */
const loadInstance = Effect.fn("Server.loadInstance")(function* (directory: InstanceDirectory) {
  const context = yield* Layer.build(instanceFolderLayer);
  const initial = yield* Context.get(context, InstanceFolder).load(directory);
  const current = yield* Layer.build(
    CurrentInstance.layer(directory, initial).pipe(Layer.provide(Layer.succeedContext(context))),
  );
  return Context.get(current, CurrentInstance);
});

// Untraced: a span around a server that never returns would parent every request span.
const serve = Effect.fnUntraced(function* (options: {
  readonly backend: ReturnType<typeof liveBackendLayer>;
  readonly webRoot: string;
  readonly port: Port;
  readonly url: string;
  readonly openSetupPage: boolean;
}) {
  yield* Layer.build(serverLayer(options.backend, options.webRoot, options.port)).pipe(
    Effect.mapError((error) => serverStartError(options.port, error)),
    Effect.catchTag("PortInUseError", ({ port }) => portInUse(port)),
  );
  yield* Console.log(
    options.openSetupPage
      ? `usine is running in setup mode at ${options.url}`
      : `usine is running at ${options.url}`,
  );
  if (options.openSetupPage) {
    yield* openBrowser(options.url).pipe(
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
  const roots = volatileRoots(Option.fromNullishOr(process.env.TMPDIR));
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
  instances: CurrentInstance["Service"],
  port: Port,
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
    const observationContext = yield* Layer.build(operatorObservationLayer(directory));
    const backend = needsSetupBackendLayer(
      instances,
      error._tag,
      Context.get(observationContext, OperatorObservation),
      Context.get(observationContext, OperatorConfiguration),
    );
    return yield* serve({ backend, webRoot, port, url, openSetupPage: true });
  }

  const shutdown = yield* Deferred.make<void>();
  const startup = Effect.gen(function* () {
    const runtime = runtimeLayer(directory).pipe(
      Layer.provide(Layer.succeed(GitHubCredentials, credentials.success)),
      Layer.provide(Layer.succeed(CurrentInstance, instances)),
    );
    const context = yield* Layer.build(runtime).pipe(
      Effect.provideService(RunEngineShutdown, shutdown),
    );
    const operator = Context.get(context, Operator);
    const orchestrator = Context.get(context, Orchestrator);
    const engine = Context.get(context, RunEngine);
    return {
      drain: engine.drain(),
      running: Effect.raceFirst(
        serve({
          backend: liveBackendLayer(
            instances,
            operator,
            Context.get(context, OperatorConfiguration),
          ),
          webRoot,
          port,
          url,
          openSetupPage: false,
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

export const up = (port: Port, allowVolatileInstance: boolean) =>
  Effect.scoped(
    Effect.gen(function* () {
      const directory = InstanceDirectory.make(process.cwd());
      yield* refuseVolatileInstance(directory, allowVolatileInstance).pipe(
        Effect.provide(NodeServices.layer),
      );
      // Acquired before any store opens and released after every store closes.
      yield* holdInstance(directory).pipe(Effect.provide(NodeServices.layer));
      yield* refuseTakenPort(port).pipe(Effect.provide(NodeServices.layer));
      const instances = yield* loadInstance(directory);
      const { config } = yield* instances.get;
      // Built before the runtime, so the exporter flushes the runtime's last spans when it closes.
      const tracer = yield* Layer.build(tracingLayer(config.tracing)).pipe(
        Effect.provide(NodeServices.layer),
      );
      return yield* start(directory, instances, port).pipe(Effect.provideContext(tracer));
    }),
  );
