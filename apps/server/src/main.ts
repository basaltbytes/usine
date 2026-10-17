#!/usr/bin/env node
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Console, Effect, Match, Option } from "effect";
import { CLI_USAGE, packageVersion, parseCli } from "./cli.ts";
import { failureMessage } from "./failure-message.ts";

const exitWith = (message: string) =>
  Console.error(message).pipe(
    Effect.andThen(
      Effect.sync(() => {
        process.exitCode = 1;
      }),
    ),
  );

const main = Effect.gen(function* () {
  const command = yield* parseCli(process.argv.slice(2), {
    port: Option.fromNullishOr(process.env.USINE_PORT),
    allowVolatileInstance: Option.fromNullishOr(process.env.USINE_ALLOW_VOLATILE_INSTANCE),
  });
  return yield* Match.valueTags(command, {
    HelpCommand: () => Console.log(CLI_USAGE),
    VersionCommand: () => Effect.flatMap(packageVersion(), Console.log),
    ExportRunCommand: ({ runId, output }) =>
      Effect.flatMap(
        Effect.promise(() => import("./export-run.ts")),
        ({ exportRun }) => exportRun(runId, output),
      ),
    BackupCommand: ({ output }) =>
      Effect.flatMap(
        Effect.promise(() => import("./backup.ts")),
        ({ backup }) => backup(output),
      ),
    UpCommand: ({ port, allowVolatileInstance }) =>
      Effect.flatMap(
        Effect.promise(() => import("./up.ts")),
        ({ up }) => up(port, allowVolatileInstance),
      ),
  });
}).pipe(
  Effect.provide(NodeServices.layer),
  // Only typed failures are caught: a defect still crashes with its full cause.
  Effect.catch((failure) => exitWith(failureMessage(failure))),
);

NodeRuntime.runMain(main);
