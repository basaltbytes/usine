import { localActor } from "@usine/core/operator";
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
import { Config, Console, DateTime, Effect, FileSystem, Layer, Option, Path } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { ConfigCommand, ConfigCommandError } from "./command.ts";
import { configurationLayer, initializeConfiguration } from "./runtime.ts";

export const runConfigCommand = Effect.fn("Cli.config")(
  function* (directory: InstanceDirectory, command: ConfigCommand) {
    const path = yield* Path.Path;
    const store = yield* ConfigurationStore;
    const folder = yield* ConfigurationFolder;
    const { instance, number } = yield* initializeConfiguration(directory);
    const entities = configurationEntities(instance);
    const resolveKey = (
      key: ConfigurationEntityKey,
    ): Effect.Effect<ConfigurationEntityKey, ConfigCommandError> =>
      Effect.fromOption(resolveConfigurationEntityKey(entities, key), () =>
        ConfigCommandError.make({
          message: `Loop ${key.identifier} is ambiguous. Use project/loop.`,
        }),
      );
    const actor = Option.some(localActor);
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
        yield* folder.export(InstanceDirectory.make(path.resolve(command.folder)), instance);
        return yield* Console.log(
          `Exported revision ${number} to ${path.resolve(command.folder)}.`,
        );
      case "ConfigImportCommand": {
        const imported = yield* folder.load(InstanceDirectory.make(path.resolve(command.folder)));
        const before = configurationEntities(instance);
        const after = configurationEntities(imported);
        return yield* save(number, configurationDiff(before, after), command.message);
      }
      case "ConfigLogCommand": {
        const entityFilter = yield* Option.match(command.entity, {
          onNone: () => Effect.succeedNone,
          onSome: (key) => resolveKey(key).pipe(Effect.asSome),
        });
        const revisions = yield* store.list(entityFilter);
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
          return yield* ConfigCommandError.make({
            message: `Unknown ${command.entity.kind} ${command.entity.identifier}.`,
          });
        const editor = yield* Config.option(Config.String("EDITOR")).pipe(Effect.orDie);
        if (Option.isNone(editor) || editor.value.trim() === "")
          return yield* ConfigCommandError.make({
            message: "Set EDITOR to the editor command to use.",
          });
        const fs = yield* FileSystem.FileSystem;
        const temporary = yield* fs.makeTempDirectoryScoped({ prefix: "usine-config-edit-" });
        const extension = entity.key.kind === "agent" || entity.key.kind === "loop" ? "md" : "yaml";
        const file = `${temporary}/entity.${extension}`;
        const formattedEntity = yield* formatConfigurationEntity(entity);
        yield* fs.writeFileString(file, formattedEntity);
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const exit = yield* spawner.exitCode(
          ChildProcess.make("sh", ["-c", `${editor.value} "$1"`, "usine-config-edit", file], {
            stdin: "inherit",
            stdout: "inherit",
            stderr: "inherit",
          }),
        );
        if (Number(exit) !== 0)
          return yield* ConfigCommandError.make({
            message: `Editor exited with status ${exit}; no revision was written.`,
          });
        const latest = yield* store.read;
        if (latest.number !== number)
          return yield* StaleRevision.make({ expected: number, actual: latest.number });
        const parser = yield* ConfigParser;
        const contents = yield* fs.readFileString(file);
        const edited = yield* parseConfigurationEntity(parser, entity.key, contents);
        return yield* save(number, configurationDiff([entity], [edited]), Option.none());
      }
    }
  },
  Effect.catchTag("PlatformError", (cause) =>
    Effect.fail(ConfigurationStoreError.make({ operation: "edit configuration", cause })),
  ),
);

export const configCommand = (directory: InstanceDirectory, command: ConfigCommand) =>
  Effect.scoped(
    Effect.gen(function* () {
      const context = yield* Layer.build(
        configurationLayer.pipe(Layer.provide(localSqliteLayer(directory))),
      );
      return yield* runConfigCommand(directory, command).pipe(Effect.provideContext(context));
    }),
  );
