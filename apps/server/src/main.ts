#!/usr/bin/env node
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { ConfigParser, InstanceFolder } from "@usine/config";
import { Instance } from "@usine/core";
import { GitHubCredentials } from "@usine/github";
import { loadLocalCredentials } from "@usine/github/local-secrets";
import { MarcbachmannCelLayer } from "@usine/expression";
import { Operator, OperatorObservation, Orchestrator } from "@usine/orchestrator";
import { operatorObservationLayer, runtimeLayer } from "@usine/orchestrator/local";
import { Console, Context, Effect, Layer, Result, Schema } from "effect";
import { liveBackendLayer, needsSetupBackendLayer } from "./backend.ts";
import { serverLayer } from "./http.ts";

const PORT = 7_331;

class CliUsageError extends Schema.TaggedError<CliUsageError>("@usine/server/CliUsageError")(
  "CliUsageError",
  { message: Schema.String },
) {}

const loadInstance = (directory: Instance.Directory) => {
  const parser = ConfigParser.layer.pipe(Layer.provide(MarcbachmannCelLayer));
  const folder = InstanceFolder.layer.pipe(
    Layer.provide(parser),
    Layer.provide(NodeServices.layer),
  );
  return Effect.flatMap(InstanceFolder, (service) => service.load(directory)).pipe(
    Effect.provide(folder),
  );
};

const up = Effect.scoped(
  Effect.gen(function* () {
    const directory = Instance.Directory.make(process.cwd());
    const instance = yield* loadInstance(directory);
    const credentials = yield* loadLocalCredentials(directory).pipe(
      Effect.provide(NodeServices.layer),
      Effect.result,
    );
    const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "web");
    const url = `http://127.0.0.1:${PORT}`;

    if (Result.isFailure(credentials)) {
      const error = credentials.failure;
      yield* Effect.logWarning("GitHub App credentials are absent; pollers are idle", {
        errorTag: error._tag,
        message: error.message,
        instanceDirectory: directory,
      });
      yield* Console.log(`usine is waiting for GitHub App setup at ${url}`);
      const observationContext = yield* Layer.build(operatorObservationLayer(directory));
      const backend = needsSetupBackendLayer(
        instance,
        error._tag,
        `${error.message} Add USINE_GITHUB_APP_ID and USINE_GITHUB_PRIVATE_KEY, or create .usine/github-app.json with mode 0600.`,
        Context.get(observationContext, OperatorObservation),
      );
      return yield* Layer.launch(serverLayer(backend, webRoot, PORT));
    }

    const runtime = runtimeLayer(directory, instance, {}).pipe(
      Layer.provide(Layer.succeed(GitHubCredentials, credentials.success)),
    );
    const context = yield* Layer.build(runtime);
    const operator = Context.get(context, Operator);
    const orchestrator = Context.get(context, Orchestrator);
    yield* Effect.forkScoped(orchestrator.run(instance));
    yield* Console.log(`usine is running at ${url}`);
    return yield* Layer.launch(serverLayer(liveBackendLayer(instance, operator), webRoot, PORT));
  }),
);

const main = Effect.gen(function* () {
  const [, , command, ...rest] = process.argv;
  if (command !== "up" || rest.length > 0) {
    return yield* new CliUsageError({ message: "Usage: usine up" });
  }
  return yield* up;
});

NodeRuntime.runMain(main);
