import { Effect, Schema } from "effect";
import { stringify } from "yaml";
import type { ConfigFileError, InstancePath } from "../file.ts";
import { splitMarkdown } from "../frontmatter.ts";
import { parseYamlDocument } from "./document.ts";

/** Writes a complete YAML document in the folder export format. */
export const writeYaml = (value: Schema.Json): string => stringify(value);

/** A replacement of one value in a YAML file. */
export class YamlEdit extends Schema.Class<YamlEdit>("@usine/config/YamlEdit")({
  /** The keys as written in the file, for example `["settings", "max_children"]`. */
  path: Schema.Array(Schema.NonEmptyString).check(Schema.isNonEmpty()),
  /** The replacement JSON value at `path`; missing mapping keys are created. */
  value: Schema.Json,
}) {}

const restoreNewlines = (text: string, newline: "\n" | "\r\n"): string => {
  const normalized = text.replaceAll("\r\n", "\n");
  return newline === "\r\n" ? normalized.replaceAll("\n", "\r\n") : normalized;
};

/**
 * Returns YAML `source` with `edit` applied, keeping comments, key order, and newline style. Uses
 * `file` only for diagnostics; parsing failures return `ConfigFileError` and no file is written.
 */
export const updateYaml = Effect.fn("YamlWriter.updateYaml")(
  (file: InstancePath, source: string, edit: YamlEdit): Effect.Effect<string, ConfigFileError> =>
    Effect.gen(function* () {
      const document = yield* parseYamlDocument(file, source);
      document.setIn(edit.path, edit.value);
      // The stringifier always emits LF.
      return restoreNewlines(document.toString(), source.includes("\r\n") ? "\r\n" : "\n");
    }),
);

/**
 * Applies `edit` to Markdown `source` frontmatter, preserving the body, comments, key order, and
 * newline style. Uses `file` for diagnostics; invalid frontmatter or YAML fails with
 * `ConfigFileError` and no file is written.
 */
export const updateFrontmatter = Effect.fn("YamlWriter.updateFrontmatter")(
  (file: InstancePath, source: string, edit: YamlEdit): Effect.Effect<string, ConfigFileError> =>
    Effect.gen(function* () {
      const markdown = yield* splitMarkdown(file, source);
      // Takes the newline style from the whole file, because one-line frontmatter has no newline.
      const updated = restoreNewlines(
        yield* updateYaml(file, markdown.yaml, edit),
        markdown.newline,
      );
      const yaml = updated.endsWith(markdown.newline)
        ? updated.slice(0, -markdown.newline.length)
        : updated;
      return `---${markdown.newline}${yaml}${markdown.newline}---${markdown.newline}${markdown.body}`;
    }),
);
