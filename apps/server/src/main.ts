#!/usr/bin/env node
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { InstanceDirectory } from "@usine/core/instance";
import { Config, ConfigProvider, Console, Effect, Layer, Match } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { CLI_USAGE, type CliEnvironment, packageVersion, parseCli } from "./cli.ts";
import { failureMessage } from "./failure-message.ts";
import { instanceEnvironment } from "./instance/environment.ts";
import { loggerLayer } from "./logger.ts";

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

const cliEnvironment: Config.Config<CliEnvironment> = Config.all({
  port: Config.option(Config.string("USINE_PORT")),
  listen: Config.option(Config.string("USINE_LISTEN")),
  logLevel: Config.option(Config.string("USINE_LOG_LEVEL")),
  allowVolatileInstance: Config.option(Config.string("USINE_ALLOW_VOLATILE_INSTANCE")),
});

// Untraced: a span around `usine up`, which never returns, would parent every span it exports.
const runCommand = Effect.fnUntraced(function* (directory: InstanceDirectory) {
  // An environment and a parsed .env don't fail to load, so a ConfigError here is a defect.
  const environment = yield* Effect.orDie(cliEnvironment);
  const command = yield* parseCli(process.argv.slice(2), environment);
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
    UpCommand: (command) =>
      command.detach
        ? Effect.flatMap(
            Effect.promise(() => import("./detach.ts")),
            ({ upDetached }) => upDetached(directory, command),
          )
        : Effect.flatMap(
            Effect.promise(() => import("./up.ts")),
            ({ up }) => up(command),
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
        ({ restart, fallbackLaunch }) => restart(directory, options, fallbackLaunch(environment)),
      ),
    UpgradeCommand: (upgradeCommand) =>
      Effect.flatMap(
        Effect.promise(() => import("./upgrade.ts")),
        ({ upgrade }) => upgrade(directory, upgradeCommand),
      ),
  });
});

const main = Effect.gen(function* () {
  const directory = InstanceDirectory.make(process.cwd());
  const environment = yield* instanceEnvironment(directory, yield* ConfigProvider.ConfigProvider);
  return yield* runCommand(directory).pipe(
    Effect.provideService(ConfigProvider.ConfigProvider, environment),
  );
}).pipe(
  Effect.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer, loggerLayer)),
  // Only typed failures are caught: a defect still crashes with its full cause.
  Effect.catch((failure) => exitWith(failureMessage(failure))),
);

NodeRuntime.runMain(main);
