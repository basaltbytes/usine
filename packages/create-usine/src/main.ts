#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { InstanceDirectory } from "@usine/core/instance";
import { ReleaseVersion } from "@usine/core/upgrade";
import { Console, Effect, FileSystem, Path, Schema } from "effect";
import { Argument, Command } from "effect/cli";
import { detectInstaller, scaffold } from "./scaffold.ts";

const Release = Schema.fromJsonString(
  Schema.Struct({ version: ReleaseVersion, serverVersion: ReleaseVersion }),
);
const main = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const release = yield* fs
    .readFileString(fileURLToPath(new URL("./release.json", import.meta.url)))
    .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Release)));
  const command = Command.make(
    "create-usine",
    {
      folder: Argument.String("folder").pipe(Argument.withSchema(Schema.NonEmptyString)),
    },
    ({ folder }) =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const directory = InstanceDirectory.make(path.resolve(folder));
        const installer = yield* detectInstaller(directory);
        yield* scaffold(directory, release.serverVersion, installer).pipe(Effect.scoped);
        const next = installer === "npm" ? "npm run usine -- up" : "pnpm usine up";
        yield* Console.log(
          `\nOpen ${directory} in your terminal, then start setup:\n\n  ${next}\n`,
        );
      }),
  ).pipe(
    Command.withDescription("Create an empty runtime folder and install a pinned usine server."),
  );
  return yield* Command.run(command, { version: release.version });
}).pipe(
  Effect.provide(NodeServices.layer),
  Effect.catchTag("ScaffoldError", (error) =>
    Console.error(`${error.directory}: ${error.message}`).pipe(
      Effect.andThen(
        Effect.sync(() => {
          process.exitCode = 1;
        }),
      ),
    ),
  ),
);

NodeRuntime.runMain(main);
