import { RepositoryName } from "@usine/core/repository";
import { Project } from "../project/project.ts";
import { Effect, Option, Record, Schema } from "effect";
import { ManagedRepo, UsineConfig, WorkerFromYaml } from "../factory.ts";
import { ConfigFileError, InstancePath } from "../file.ts";
import { parseAgentFile, parseLoopDraft } from "../parser.ts";
import { parseYamlDocument } from "../yaml/document.ts";
import type { ConfigurationEntityKey } from "./model.ts";
import { AgentJson, LoopJson } from "./entities.ts";

const {
  workers: _workers,
  repos: _repos,
  labels: _labels,
  projects: _projects,
  ...settings
} = UsineConfig.fields;
const SettingsEntity = Schema.Struct(settings);
const ProjectDraft = Schema.Struct({
  ...Project.fields,
  repositories: Schema.Array(RepositoryName),
});
const formSchemas = {
  project: Project,
  agent: AgentJson,
  loop: LoopJson,
  worker: WorkerFromYaml,
  repository: ManagedRepo,
  settings: SettingsEntity,
};
/** The entity kinds supported by configuration forms; labels use the text editor. */
export const ConfigurationFormKind = Schema.Literals(Record.keys(formSchemas));
const isFormKind = Schema.is(ConfigurationFormKind);

/**
 * Checks `value` against the entity schema selected by `key` and returns the original JSON object.
 * Unsupported kinds, unknown fields, or schema failures return `ConfigFileError`; CEL and
 * reference checks happen separately.
 */
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

/**
 * Parses export-format `text` for `key` into form JSON. Allows empty project membership in drafts
 * and omits repository lanes; loop expressions remain unchecked. Invalid syntax or schema fields
 * fail with `ConfigFileError`.
 */
export const parseConfigurationForm = (key: ConfigurationEntityKey, text: string) => {
  const file = InstancePath.make(key.key);
  if (key.kind === "loop")
    return parseLoopDraft(InstancePath.make(`loops/${key.identifier}.md`), text).pipe(
      Effect.map(Schema.encodeSync(LoopJson)),
      Effect.flatMap((value) => Schema.decodeUnknownEffect(Schema.JsonObject)(value)),
      Effect.catchTag("SchemaError", (error) =>
        Effect.fail(ConfigFileError.fromSchema(file, error)),
      ),
    );
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
    Effect.flatMap((value) => {
      if (key.kind === "project")
        return Schema.decodeUnknownEffect(ProjectDraft)(value, {
          onExcessProperty: "error",
          errors: "all",
        }).pipe(
          Effect.as(value),
          Effect.mapError((error) => ConfigFileError.fromSchema(file, error)),
        );
      if (key.kind === "repository") {
        const { lanes: _lanes, ...repository } = value;
        return validateConfigurationForm(key, repository);
      }
      return validateConfigurationForm(key, value);
    }),
  );
};
