#!/usr/bin/env node
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { InstanceDirectory } from "@usine/core/instance";
import { Console, Effect, Layer, Match, Option } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { CLI_USAGE, packageVersion, parseCli } from "./cli.ts";
import { failureMessage } from "./failure-message.ts";

/** The exit status of `usine status` when no `usine up` runs, as for LSB init scripts. */
const NOT_RUNNING_STATUS = 3;

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
    logLevel: Option.fromNullishOr(process.env.USINE_LOG_LEVEL),
    allowVolatileInstance: Option.fromNullishOr(process.env.USINE_ALLOW_VOLATILE_INSTANCE),
  });
  const directory = InstanceDirectory.make(process.cwd());
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
        ({ backup }) => backup(directory, output),
      ),
    UpCommand: ({ port, logLevel, allowVolatileInstance, detach }) =>
      detach
        ? Effect.flatMap(
            Effect.promise(() => import("./detach.ts")),
            ({ upDetached }) => upDetached(directory, port, logLevel, allowVolatileInstance),
          )
        : Effect.flatMap(
            Effect.promise(() => import("./up.ts")),
            ({ up }) => up(port, logLevel, allowVolatileInstance),
          ),
    StatusCommand: () =>
      Effect.flatMap(
        Effect.promise(() => import("./status.ts")),
        ({ status }) => status(directory),
      ).pipe(
        Effect.flatMap(({ running, lines }) =>
          Effect.forEach(lines, (line) => Console.log(line), { discard: true }).pipe(
            Effect.andThen(
              Effect.sync(() => {
                if (!running) process.exitCode = NOT_RUNNING_STATUS;
              }),
            ),
          ),
        ),
      ),
    StopCommand: ({ options }) =>
      Effect.flatMap(
        Effect.promise(() => import("./stop.ts")),
        ({ stop }) => stop(directory, options),
      ),
    RestartCommand: ({ options }) =>
      Effect.flatMap(
        Effect.promise(() => import("./restart.ts")),
        ({ restart }) => restart(directory, options),
      ),
    UpgradeCommand: (upgradeCommand) =>
      Effect.flatMap(
        Effect.promise(() => import("./upgrade.ts")),
        ({ upgrade }) => upgrade(directory, upgradeCommand),
      ),
  });
}).pipe(
  Effect.provide(Layer.merge(NodeServices.layer, FetchHttpClient.layer)),
  // Only typed failures are caught: a defect still crashes with its full cause.
  Effect.catch((failure) => exitWith(failureMessage(failure))),
);

NodeRuntime.runMain(main);
