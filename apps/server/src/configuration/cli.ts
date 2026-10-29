import { AuthStore } from "../auth/store.ts";
import { sqliteAuthLayer } from "../auth/sqlite.ts";
import { readAdminToken } from "../auth/local.ts";
import { resolve } from "node:path";
import {
  StaleRevision,
  ConfigurationStore,
  ConfigurationStoreError,
  configurationDiff,
  configurationEntities,
  resolveConfigurationEntityKey,
  type ConfigurationChange,
  type ConfigurationEntityKey,
  type ConfigurationRevisionNumber,
} from "@usine/config/configuration";
import {
  ConfigurationFolder,
  formatConfigurationEntity,
  parseConfigurationEntity,
} from "@usine/config/folder-codec";
import { ConfigParser } from "@usine/config/parser";
import { InstanceDirectory } from "@usine/core/instance";
import { localSqliteLayer } from "@usine/engine/local-sqlite";
import { Config, Console, DateTime, Effect, FileSystem, Layer, Option } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { ConfigCommand, ConfigCommandError } from "./command.ts";
import { configurationLayer, initializeConfiguration } from "./runtime.ts";

export const runConfigCommand = Effect.fn("Cli.config")(
  function* (directory: InstanceDirectory, command: ConfigCommand) {
    const store = yield* ConfigurationStore;
    const folder = yield* ConfigurationFolder;
    const { instance, number } = yield* initializeConfiguration(directory);
    const resolveKey = (
      key: ConfigurationEntityKey,
    ): Effect.Effect<ConfigurationEntityKey, ConfigCommandError> =>
      Option.match(resolveConfigurationEntityKey(configurationEntities(instance), key), {
        onSome: Effect.succeed,
        onNone: () =>
          Effect.fail(
            new ConfigCommandError({
              message: `Loop ${key.identifier} is ambiguous. Use project/loop.`,
            }),
          ),
      });
    const members = yield* Effect.flatMap(AuthStore, (auth) => auth.members);
    const firstMember = members[0];
    if (firstMember !== undefined) yield* readAdminToken(directory);
    const actor =
      firstMember === undefined ? (yield* store.read).actor : Option.some(firstMember.login);
    const save = (
      expected: ConfigurationRevisionNumber,
      changes: ReadonlyArray<ConfigurationChange>,
      message: Option.Option<string>,
    ) =>
      Effect.gen(function* () {
        if (changes.length === 0) {
          yield* Console.log("No configuration changes.");
          return;
        }
        const revision = yield* store.commit({
          expected,
          changes,
          message,
          actor,
        });
        yield* Console.log(`Revision ${revision.number}: ${changes.length} change(s).`);
        yield* Effect.forEach(
          changes,
          ({ key, before, after }) =>
            Console.log(
              `${Option.isNone(after) ? "Removed" : Option.isNone(before) ? "Added" : "Changed"} ${key.kind} ${key.identifier}`,
            ),
          { discard: true },
        );
      });
    switch (command._tag) {
      case "ConfigExportCommand":
        yield* folder.export(InstanceDirectory.make(resolve(command.folder)), instance);
        return yield* Console.log(`Exported revision ${number} to ${resolve(command.folder)}.`);
      case "ConfigImportCommand": {
        const imported = yield* folder.load(InstanceDirectory.make(resolve(command.folder)));
        return yield* save(
          number,
          configurationDiff(configurationEntities(instance), configurationEntities(imported)),
          command.message,
        );
      }
      case "ConfigLogCommand": {
        const revisions = yield* store.list(
          yield* Option.match(command.entity, {
            onNone: () => Effect.succeed(Option.none()),
            onSome: (key) => resolveKey(key).pipe(Effect.map(Option.some)),
          }),
        );
        return yield* Effect.forEach(
          revisions,
          (revision) =>
            Console.log(
              [
                revision.number,
                Option.getOrElse(revision.actor, () => "(operator not configured)"),
                DateTime.formatIso(revision.time),
                Option.getOrElse(revision.message, () => ""),
              ].join("\t"),
            ),
          { discard: true },
        );
      }
      case "ConfigEditCommand": {
        const entities = configurationEntities(instance);
        const resolved = yield* resolveKey(command.entity);
        const entity = entities.find(({ key }) => key.key === resolved.key);
        if (entity === undefined)
          return yield* new ConfigCommandError({
            message: `Unknown ${command.entity.kind} ${command.entity.identifier}.`,
          });
        const editor = yield* Config.option(Config.String("EDITOR")).pipe(Effect.orDie);
        if (Option.isNone(editor) || editor.value.trim() === "")
          return yield* new ConfigCommandError({
            message: "Set EDITOR to the editor command to use.",
          });
        const fs = yield* FileSystem.FileSystem;
        const temporary = yield* fs.makeTempDirectoryScoped({ prefix: "usine-config-edit-" });
        const extension = entity.key.kind === "agent" || entity.key.kind === "loop" ? "md" : "yaml";
        const file = `${temporary}/entity.${extension}`;
        yield* fs.writeFileString(file, yield* formatConfigurationEntity(entity));
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const exit = yield* spawner.exitCode(
          ChildProcess.make("sh", ["-c", `${editor.value} "$1"`, "usine-config-edit", file], {
            stdin: "inherit",
            stdout: "inherit",
            stderr: "inherit",
          }),
        );
        if (Number(exit) !== 0)
          return yield* new ConfigCommandError({
            message: `Editor exited with status ${exit}; no revision was written.`,
          });
        const latest = yield* store.read;
        if (latest.number !== number)
          return yield* new StaleRevision({ expected: number, actual: latest.number });
        const edited = yield* parseConfigurationEntity(
          yield* ConfigParser,
          entity.key,
          yield* fs.readFileString(file),
        );
        return yield* save(number, configurationDiff([entity], [edited]), Option.none());
      }
    }
  },
  Effect.catchTag("PlatformError", (cause) =>
    Effect.fail(new ConfigurationStoreError({ operation: "edit configuration", cause })),
  ),
);

export const configCommand = (directory: InstanceDirectory, command: ConfigCommand) =>
  runConfigCommand(directory, command).pipe(
    Effect.provide(
      Layer.mergeAll(configurationLayer, sqliteAuthLayer).pipe(
        Layer.provide(localSqliteLayer(directory)),
      ),
    ),
    Effect.scoped,
  );
