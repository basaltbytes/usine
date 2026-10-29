import type { ConfigurationEntityKey } from "@usine/config/configuration";
import {
  ConfigurationFormKind,
  parseConfigurationForm,
  validateConfigurationForm,
} from "@usine/config/folder-codec";
import { writeYaml } from "@usine/config/yaml/writer";
import { Effect, Schema } from "effect";

export type FormProblem = { readonly path: readonly (string | number)[]; readonly message: string };
export type FormFieldsProps = {
  readonly value: Schema.JsonObject;
  readonly onChange: (value: Schema.JsonObject) => void;
  readonly problems: readonly FormProblem[];
};

export const objectValue = (value: Schema.Json | undefined): Schema.JsonObject =>
  Schema.is(Schema.JsonObject)(value) ? value : {};
export const arrayValue = (value: Schema.Json | undefined): readonly Schema.Json[] =>
  Schema.is(Schema.Array(Schema.Json))(value) ? value : [];
export const stringValue = (value: Schema.Json | undefined): string =>
  Schema.is(Schema.String)(value) ? value : Schema.is(Schema.Number)(value) ? String(value) : "";

export const fieldValue = (value: Schema.JsonObject, path: string): Schema.Json | undefined =>
  path
    .split(".")
    .reduce<Schema.Json | undefined>((current, key) => objectValue(current)[key], value);

export const withField = (
  value: Schema.JsonObject,
  path: string,
  next: Schema.Json | undefined,
): Schema.JsonObject => {
  const [key, ...rest] = path.split(".");
  if (key === undefined) return value;
  const copy = { ...value };
  if (rest.length > 0) copy[key] = withField(objectValue(value[key]), rest.join("."), next);
  else if (next === undefined) delete copy[key];
  else copy[key] = next;
  return copy;
};

export const readForm = (key: ConfigurationEntityKey, text: string) =>
  Effect.runSync(Effect.result(parseConfigurationForm(key, text)));
export const validateForm = (key: ConfigurationEntityKey, value: Schema.JsonObject) =>
  Effect.runSync(Effect.result(validateConfigurationForm(key, value)));

export const formText = (key: ConfigurationEntityKey, value: Schema.JsonObject): string => {
  if (key.kind !== "agent") return writeYaml(value);
  const { name: _name, persona, parentModel, parentEffort, ...frontmatter } = value;
  let authored = frontmatter;
  const model = objectValue(parentModel);
  const effort = objectValue(parentEffort);
  if (model._tag === "Some" && model.value !== undefined)
    authored = { ...authored, parent_model: model.value };
  if (effort._tag === "Some" && effort.value !== undefined)
    authored = { ...authored, parent_effort: effort.value };
  return `---\n${writeYaml(authored)}---\n${stringValue(persona)}`;
};

export const hasForm = (key: ConfigurationEntityKey) => Schema.is(ConfigurationFormKind)(key.kind);
