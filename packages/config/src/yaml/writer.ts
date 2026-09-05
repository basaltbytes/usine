import { Effect, Schema } from "effect";
import type { ConfigFileError, InstancePath } from "../file.ts";
import { splitMarkdown } from "../frontmatter.ts";
import { parseYamlDocument } from "./document.ts";

/** One replacement in authored YAML, preserving the surrounding file. */
export class YamlEdit extends Schema.Class<YamlEdit>("@usine/config/YamlEdit")({
  /** Path in file-key spelling, for example `["settings", "max_children"]`. */
  path: Schema.Array(Schema.NonEmptyString).check(Schema.isNonEmpty()),
  value: Schema.Json,
}) {}

const restoreNewlines = (text: string, newline: "\n" | "\r\n"): string => {
  const normalized = text.replaceAll("\r\n", "\n");
  return newline === "\r\n" ? normalized.replaceAll("\n", "\r\n") : normalized;
};

/** Sets one YAML path and returns the file with its comments, key order, and newline style intact. */
export const updateYaml = Effect.fn("YamlWriter.updateYaml")(
  (file: InstancePath, source: string, edit: YamlEdit): Effect.Effect<string, ConfigFileError> =>
    Effect.gen(function* () {
      const document = yield* parseYamlDocument(file, source);
      document.setIn(edit.path, edit.value);
      // The stringifier always emits LF.
      return restoreNewlines(document.toString(), source.includes("\r\n") ? "\r\n" : "\n");
    }),
);

/** Sets one YAML path in the frontmatter of a Markdown config file and returns the whole file. */
export const updateFrontmatter = Effect.fn("YamlWriter.updateFrontmatter")(
  (file: InstancePath, source: string, edit: YamlEdit): Effect.Effect<string, ConfigFileError> =>
    Effect.gen(function* () {
      const markdown = yield* splitMarkdown(file, source);
      // A one-line YAML half has no newline to infer a style from, so the file's
      // delimiter decides.
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
