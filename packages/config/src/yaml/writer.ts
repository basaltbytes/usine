import { Effect, Schema } from "effect";
import type { ConfigFileError, InstancePath } from "../file.ts";
import { splitMarkdown } from "../frontmatter.ts";
import { parseYamlDocument } from "./document.ts";

export class YamlEdit extends Schema.Class<YamlEdit>("@usine/config/YamlEdit")({
  path: Schema.Array(Schema.NonEmptyString).check(Schema.isNonEmpty()),
  value: Schema.Json,
}) {}

const restoreNewlines = (text: string, newline: "\n" | "\r\n"): string => {
  const normalized = text.replaceAll("\r\n", "\n");
  return newline === "\r\n" ? normalized.replaceAll("\n", "\r\n") : normalized;
};

/** Mutate one YAML path through the Document AST, retaining comments and key order. */
export const updateYaml = Effect.fn("YamlWriter.updateYaml")(
  (file: InstancePath, source: string, edit: YamlEdit): Effect.Effect<string, ConfigFileError> =>
    Effect.gen(function* () {
      const document = yield* parseYamlDocument(file, source);
      document.setIn(edit.path, edit.value);
      // The AST stringifier always emits LF; restore the authored style.
      return restoreNewlines(document.toString(), source.includes("\r\n") ? "\r\n" : "\n");
    }),
);

/** Apply the same surgical mutation to the YAML half of a Markdown config file. */
export const updateFrontmatter = Effect.fn("YamlWriter.updateFrontmatter")(
  (file: InstancePath, source: string, edit: YamlEdit): Effect.Effect<string, ConfigFileError> =>
    Effect.gen(function* () {
      const markdown = yield* splitMarkdown(file, source);
      // A one-line YAML half carries no newline of its own, so the file's
      // delimiter style — not the half's content — decides the output style.
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
