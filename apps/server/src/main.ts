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
              `Could not open the runtime store at ${source} (${reason}). Run usine backup from the instance folder that holds .usine/runtime.sqlite.`,
          ),
          Match.when(
            "copy",
            () =>
              `Could not copy the runtime store at ${source} into ${destination} (${reason}). Check the instance database and the space and permissions of the output directory before retrying.`,
          ),
          Match.when(
            "stage",
            () =>
              `Could not stage the backup beside ${destination} (${reason}). Choose an output path inside an existing writable directory.`,
          ),
          Match.when("publish", () =>
            // Without a platform description the reason is its normalized tag, and
            // AlreadyExists is the deliberate refusal to replace a file. Anything else
            // means the completed copy could not be linked into place.
            reason === "AlreadyExists"
              ? `Could not publish the backup at ${destination} (${reason}). Choose a new output path; backups never replace existing files.`
              : `Could not publish the backup at ${destination} (${reason}). The completed copy is hard-linked into place; use an output directory on a filesystem that supports hard links, or resolve the reported reason, and retry.`,
          ),
          Match.exhaustive,
        ),
      ),
    VolatileInstanceDirectoryError: ({ directory, root }) =>
      exitWith(
        `Refusing to start: ${directory} sits under ${root}, which the OS clears. The runtime store there is the only copy of every Run and transcript. Move the instance folder, or pass --allow-volatile-instance (or USINE_ALLOW_VOLATILE_INSTANCE=1) to proceed anyway.`,
      ),
    PortInUseError: ({ port }) =>
      exitWith(
        `Port ${port} is already in use. Stop the process using it or run usine up --port <port>.`,
      ),
  }),
);

NodeRuntime.runMain(main);
