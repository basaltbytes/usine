import { Effect, Option, Schema } from "effect";
import { ConfigFileError, InstancePath } from "../file.ts";
import { type ConfigParser, formatAgent, formatLoop, parseLoopDraft } from "../parser.ts";
import { parseYamlDocument } from "../yaml/document.ts";
import { writeYaml } from "../yaml/writer.ts";
import { AgentJson, LoopJson } from "./entities.ts";
import { ConfigurationEntity, ConfigurationEntityKey, ConfigurationInvalid } from "./model.ts";

/**
 * Formats `entity` as Markdown for an agent or loop, or YAML for other kinds. Invalid agent or
 * loop JSON fails with `ConfigurationInvalid`.
 */
export const formatConfigurationEntity = (
  entity: ConfigurationEntity,
): Effect.Effect<string, ConfigurationInvalid> => {
  const source =
    entity.key.kind === "agent"
      ? Schema.decodeEffect(AgentJson)(entity.value).pipe(Effect.map(formatAgent))
      : entity.key.kind === "loop"
        ? Schema.decodeEffect(LoopJson)(entity.value).pipe(Effect.map(formatLoop))
        : Effect.succeed(writeYaml(entity.value));
  return source.pipe(
    Effect.mapError((error) =>
      ConfigurationInvalid.make({
        problems: [ConfigFileError.fromSchema(InstancePath.make(entity.key.key), error)],
      }),
    ),
  );
};

/**
 * Formats `entity` from a stored revision like `formatConfigurationEntity`. Writes an agent or loop
 * value that the current rules reject as YAML of its stored JSON.
 */
export const formatRevisionEntity = (entity: ConfigurationEntity): Effect.Effect<string> =>
  formatConfigurationEntity(entity).pipe(
    Effect.catchTag("ConfigurationInvalid", ({ problems }) =>
      Effect.logDebug("Stored configuration value no longer decodes; showing its stored JSON", {
        entity: entity.key.key,
        problems: problems.map(({ message }) => message),
      }).pipe(Effect.as(writeYaml(entity.value))),
    ),
  );

/**
 * Parses `source` in the export format for `key`, using `parser` for agents. Loop expressions and
 * references require later validation; other kinds decode as YAML JSON. Parsing failures become
 * `ConfigurationInvalid`.
 */
export const parseConfigurationEntity = (
  parser: ConfigParser["Service"],
  key: ConfigurationEntityKey,
  source: string,
): Effect.Effect<ConfigurationEntity, ConfigurationInvalid> => {
  const file = InstancePath.make(`${key.kind}/${key.identifier}`);
  const value: Effect.Effect<Schema.Json, ConfigFileError | Schema.SchemaError> =
    key.kind === "agent"
      ? parser
          .parseAgentFile(InstancePath.make(`agents/${key.identifier}.md`), source)
          .pipe(Effect.flatMap(Schema.encodeEffect(AgentJson)))
      : key.kind === "loop"
        ? parseLoopDraft(InstancePath.make(`loops/${key.identifier}.md`), source).pipe(
            Effect.flatMap(Schema.encodeEffect(LoopJson)),
          )
        : parseYamlDocument(file, source).pipe(
            Effect.flatMap((document) =>
              Schema.decodeUnknownEffect(Schema.Json)(document.toJS()).pipe(
                Effect.mapError((error) =>
                  ConfigFileError.make({
                    file,
                    stage: "schema",
                    expression: Option.none(),
                    message: error.message,
                  }),
                ),
              ),
            ),
          );
  return value.pipe(
    Effect.mapBoth({
      onSuccess: (value) => ConfigurationEntity.make({ key, value }),
      onFailure: (problem) =>
        ConfigurationInvalid.make({
          problems: [
            Schema.is(ConfigFileError)(problem)
              ? problem
              : ConfigFileError.fromSchema(file, problem),
          ],
        }),
    }),
  );
};
