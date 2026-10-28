import { Effect, Option, Schema } from "effect";
import { ConfigFileError, InstancePath } from "../file.ts";
import { type ConfigParser, formatAgent, formatLoop } from "../parser.ts";
import { parseYamlDocument } from "../yaml/document.ts";
import { writeYaml } from "../yaml/writer.ts";
import { AgentJson, LoopJson } from "./entities.ts";
import { ConfigurationEntity, ConfigurationEntityKey, ConfigurationInvalid } from "./model.ts";

export const formatConfigurationEntity = (
  entity: ConfigurationEntity,
): Effect.Effect<string, ConfigurationInvalid> => {
  const source =
    entity.key.kind === "agent"
      ? Schema.decodeUnknownEffect(AgentJson)(entity.value).pipe(Effect.map(formatAgent))
      : entity.key.kind === "loop"
        ? Schema.decodeUnknownEffect(LoopJson)(entity.value).pipe(Effect.map(formatLoop))
        : Effect.succeed(writeYaml(entity.value));
  return source.pipe(
    Effect.mapError(
      (error) =>
        new ConfigurationInvalid({
          problems: [
            new ConfigFileError({
              file: InstancePath.make(entity.key.key),
              stage: "schema",
              expression: Option.none(),
              message: error.message,
            }),
          ],
        }),
    ),
  );
};

export const parseConfigurationEntity = (
  parser: ConfigParser["Service"],
  key: ConfigurationEntityKey,
  source: string,
): Effect.Effect<ConfigurationEntity, ConfigurationInvalid> => {
  const file = InstancePath.make(`${key.kind}/${key.identifier}`);
  const value: Effect.Effect<Schema.Json, ConfigFileError> =
    key.kind === "agent"
      ? parser
          .parseAgentFile(InstancePath.make(`agents/${key.identifier}.md`), source)
          .pipe(Effect.map(Schema.encodeSync(AgentJson)))
      : key.kind === "loop"
        ? parser
            .parseLoopFile(InstancePath.make(`loops/${key.identifier}.md`), source)
            .pipe(Effect.map(Schema.encodeSync(LoopJson)))
        : parseYamlDocument(file, source).pipe(
            Effect.flatMap((document) =>
              Schema.decodeUnknownEffect(Schema.Json)(document.toJS()).pipe(
                Effect.mapError(
                  (error) =>
                    new ConfigFileError({
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
    Effect.map((value) => new ConfigurationEntity({ key, value })),
    Effect.mapError((problem) => new ConfigurationInvalid({ problems: [problem] })),
  );
};
