#!/usr/bin/env node
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Console, Effect, Match, Option } from "effect";
import { CLI_USAGE, packageVersion, parseCli } from "./cli.ts";

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
  Effect.catchTags({
    CliUsageError: ({ message }) => exitWith(message),
    RunNotFoundError: ({ runId }) => exitWith(`Run ${runId} was not found.`),
    RunExportError: ({ runId, operation, path, reason }) =>
      exitWith(
        `Could not ${operation} evidence for Run ${runId} at ${path} (${reason}). Check the instance database and choose a new writable output path.`,
      ),
    RuntimeStoreBackupError: ({ operation, source, destination, reason }) =>
      exitWith(
        Match.value(operation).pipe(
          Match.when(
            "open",
            () =>
              `Could not open ${source} (${reason}). Run usine backup from the instance folder containing .usine/runtime.sqlite.`,
          ),
          Match.when(
            "copy",
            () =>
              `Could not copy ${source} to ${destination} (${reason}). Check the source database and the output directory's free space and permissions.`,
          ),
          Match.when(
            "stage",
            () =>
              `Could not create a backup at ${destination} (${reason}). Choose an existing writable output directory.`,
          ),
          Match.when("publish", () =>
            reason === "AlreadyExists"
              ? `Could not save the backup to ${destination} (${reason}). Choose a different filename; the destination already exists.`
              : `Could not save the backup to ${destination} (${reason}). Check the destination path and permissions; its filesystem must support hard links.`,
          ),
          Match.exhaustive,
        ),
      ),
    VolatileInstanceDirectoryError: ({ directory, root }) =>
      exitWith(
        `Refusing to start: ${directory} sits under ${root}, which the OS clears. The runtime store there is the only copy of every Run and transcript. Move the instance folder, or pass --allow-volatile-instance (or USINE_ALLOW_VOLATILE_INSTANCE=1) to proceed anyway.`,
      ),
    InstanceInUseError: ({ directory, holder }) =>
      exitWith(
        `usine up did not start: another usine process${Option.match(holder, {
          onNone: () => "",
          onSome: (pid) => ` (pid ${pid})`,
        })} is running in ${directory}, possibly still draining its Attempts. Wait for it to exit or stop it, then run usine up again.`,
      ),
    InstanceLockError: ({ directory, reason }) =>
      exitWith(
        `usine up did not start: could not lock ${directory}/.usine/instance.lock (${reason}). Check that the folder is writable.`,
      ),
    PortInUseError: ({ port, holder }) =>
      exitWith(
        `usine up stopped: port ${port} is already in use${Option.match(holder, {
          onNone: () => "",
          onSome: (pid) => ` (pid ${pid})`,
        })}. Stop the process using it or run usine up --port <port>.`,
      ),
  }),
);

NodeRuntime.runMain(main);
