import { Effect, Option, Record, Schema } from "effect";
import { ManagedRepo, UsineConfig, WorkerFromYaml } from "../factory.ts";
import { ConfigFileError, InstancePath } from "../file.ts";
import { parseAgentFile } from "../parser.ts";
import { parseYamlDocument } from "../yaml/document.ts";
import type { ConfigurationEntityKey } from "./model.ts";
import { AgentJson } from "./entities.ts";

const { workers: _workers, repos: _repos, labels: _labels, ...settings } = UsineConfig.fields;
const SettingsEntity = Schema.Struct(settings);
const formSchemas = {
  agent: AgentJson,
  worker: WorkerFromYaml,
  repository: ManagedRepo,
  settings: SettingsEntity,
};
export const ConfigurationFormKind = Schema.Literals(Record.keys(formSchemas));
const isFormKind = Schema.is(ConfigurationFormKind);

/** Decodes a form draft with the same schema used when saving the entity. */
export const validateConfigurationForm = (
  key: ConfigurationEntityKey,
  value: Schema.JsonObject,
) => {
  if (!isFormKind(key.kind))
    return Effect.fail(
      new ConfigFileError({
        file: InstancePath.make(key.key),
        stage: "schema",
        expression: Option.none(),
        message: "Use the text editor for this configuration entity.",
      }),
    );
  const schema = formSchemas[key.kind];
  return Schema.decodeUnknownEffect(schema)(value, {
    onExcessProperty: "error",
    errors: "all",
  }).pipe(
    Effect.as(value),
    Effect.mapError((error) => ConfigFileError.fromSchema(InstancePath.make(key.key), error)),
  );
};

/** Reads an entity's export format for the form editor. */
export const parseConfigurationForm = (key: ConfigurationEntityKey, text: string) => {
  const file = InstancePath.make(key.key);
  if (key.kind === "agent")
    return parseAgentFile(InstancePath.make(`agents/${key.identifier}.md`), text).pipe(
      Effect.map(Schema.encodeSync(AgentJson)),
      Effect.flatMap((value) => Schema.decodeUnknownEffect(Schema.JsonObject)(value)),
      Effect.catchTag("SchemaError", (error) =>
        Effect.fail(ConfigFileError.fromSchema(file, error)),
      ),
    );
  return parseYamlDocument(file, text).pipe(
    Effect.flatMap((document) => Schema.decodeUnknownEffect(Schema.JsonObject)(document.toJS())),
    Effect.catchTag("SchemaError", (error) => Effect.fail(ConfigFileError.fromSchema(file, error))),
    Effect.flatMap((value) => validateConfigurationForm(key, value)),
  );
};
