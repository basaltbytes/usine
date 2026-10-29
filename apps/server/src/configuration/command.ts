import { ConfigurationEntityKey } from "@usine/config/configuration";
import { Effect, Option, Schema } from "effect";

class ConfigExportCommand extends Schema.TaggedClass<ConfigExportCommand>("ConfigExportCommand")(
  "ConfigExportCommand",
  {
    folder: Schema.NonEmptyString,
  },
) {}
class ConfigImportCommand extends Schema.TaggedClass<ConfigImportCommand>("ConfigImportCommand")(
  "ConfigImportCommand",
  {
    folder: Schema.NonEmptyString,
    message: Schema.Option(Schema.String),
  },
) {}
class ConfigEditCommand extends Schema.TaggedClass<ConfigEditCommand>("ConfigEditCommand")(
  "ConfigEditCommand",
  {
    entity: ConfigurationEntityKey,
  },
) {}
class ConfigLogCommand extends Schema.TaggedClass<ConfigLogCommand>("ConfigLogCommand")(
  "ConfigLogCommand",
  {
    entity: Schema.Option(ConfigurationEntityKey),
  },
) {}
export const ConfigCommand = Schema.Union([
  ConfigExportCommand,
  ConfigImportCommand,
  ConfigEditCommand,
  ConfigLogCommand,
]);
export type ConfigCommand = typeof ConfigCommand.Type;

export class ConfigCommandError extends Schema.TaggedError<ConfigCommandError>(
  "ConfigCommandError",
)("ConfigCommandError", { message: Schema.String }) {}

const usage = () =>
  new ConfigCommandError({
    message:
      "Use usine config export <folder>, import <folder> [--message <text>], edit <kind> <name>, or log [<kind> <name>]. Kinds: settings, worker, repository, project, label, loop, agent. Settings use the name instance.",
  });

export const parseConfigCommand = (
  args: ReadonlyArray<string>,
): Effect.Effect<ConfigCommand, ConfigCommandError> =>
  Effect.gen(function* () {
    const [command, first, second, third] = args;
    switch (command) {
      case "export":
        if (args.length !== 2 || first === undefined || first === "" || first.startsWith("-"))
          return yield* usage();
        return new ConfigExportCommand({ folder: first });
      case "import":
        if (
          first === undefined ||
          first === "" ||
          first.startsWith("-") ||
          !(args.length === 2 || (args.length === 4 && second === "--message"))
        )
          return yield* usage();
        return new ConfigImportCommand({ folder: first, message: Option.fromUndefinedOr(third) });
      case "log":
      case "edit": {
        if (command === "log" && args.length === 1)
          return new ConfigLogCommand({ entity: Option.none() });
        if (args.length !== 3) return yield* usage();
        const entity = yield* Schema.decodeUnknownEffect(ConfigurationEntityKey)({
          kind: first,
          identifier: second,
        }).pipe(Effect.mapError(usage));
        return command === "edit"
          ? new ConfigEditCommand({ entity })
          : new ConfigLogCommand({ entity: Option.some(entity) });
      }
      default:
        return yield* usage();
    }
  });
