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
      ? Schema.decodeEffect(AgentJson)(entity.value).pipe(Effect.flatMap(formatAgent))
      : entity.key.kind === "loop"
        ? Schema.decodeEffect(LoopJson)(entity.value).pipe(Effect.flatMap(formatLoop))
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
