import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { NodeServices } from "@effect/platform-node";
import { InstanceFolder } from "@usine/config/instance-folder";
import { ConfigParser } from "@usine/config/parser";
import { InstanceDirectory } from "@usine/core/instance";
import { MarcbachmannCelLayer } from "@usine/expression/marcbachmann-cel";
import { GitHubCredentials } from "@usine/github/github-app";
import { loadLocalCredentials } from "@usine/github/local-secrets";
import { Operator, OperatorObservation } from "@usine/orchestrator/operator";
import { Orchestrator } from "@usine/orchestrator/orchestrator";
import { operatorObservationLayer, runtimeLayer } from "@usine/orchestrator/local";
import { Console, Context, Effect, FileSystem, Layer, Option, Result } from "effect";
import { liveBackendLayer, needsSetupBackendLayer } from "./backend.ts";
import {
  type Port,
  VolatileInstanceDirectoryError,
  openBrowser,
  serverStartError,
  volatileRoot,
  volatileRoots,
} from "./cli.ts";
import { serverLayer } from "./http.ts";

const loadInstance = (directory: InstanceDirectory) => {
  const parser = ConfigParser.layer.pipe(Layer.provide(MarcbachmannCelLayer));
  const folder = InstanceFolder.layer.pipe(
    Layer.provide(parser),
    Layer.provide(NodeServices.layer),
  );
  return Effect.flatMap(InstanceFolder, (service) => service.load(directory)).pipe(
    Effect.provide(folder),
  );
};

const serve = Effect.fn("Server.serve")(function* (options: {
  readonly backend: ReturnType<typeof liveBackendLayer>;
  readonly webRoot: string;
  readonly port: Port;
  readonly url: string;
  readonly openSetupPage: boolean;
}) {
  yield* Layer.build(serverLayer(options.backend, options.webRoot, options.port)).pipe(
    Effect.mapError((error) => serverStartError(options.port, error)),
  );
  yield* Console.log(
    options.openSetupPage
      ? `usine is waiting for GitHub App setup at ${options.url}`
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

export const up = (port: Port, allowVolatileInstance: boolean) =>
  Effect.scoped(
    Effect.gen(function* () {
      const directory = InstanceDirectory.make(process.cwd());
      yield* refuseVolatileInstance(directory, allowVolatileInstance).pipe(
        Effect.provide(NodeServices.layer),
      );
      const instance = yield* loadInstance(directory);
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
          instance,
          error._tag,
          Context.get(observationContext, OperatorObservation),
        );
        return yield* serve({ backend, webRoot, port, url, openSetupPage: true });
      }

      const runtime = runtimeLayer(directory, instance, {}).pipe(
        Layer.provide(Layer.succeed(GitHubCredentials, credentials.success)),
      );
      const context = yield* Layer.build(runtime);
      const operator = Context.get(context, Operator);
      const orchestrator = Context.get(context, Orchestrator);
      // Race rather than fork: a defect in the trigger streams or the HTTP server
      // must take the whole process down instead of leaving a live UI over a dead factory.
      return yield* Effect.raceFirst(
        serve({
          backend: liveBackendLayer(instance, operator),
          webRoot,
          port,
          url,
          openSetupPage: false,
        }),
        orchestrator
          .run(instance)
          .pipe(
            Effect.tapCause((cause) =>
              Effect.logFatal("Trigger streams stopped; shutting the server down", { cause }),
            ),
          ),
      );
    }),
  );
