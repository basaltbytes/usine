import { Effect, Schema } from "effect";
import type { ConfigFileError, InstancePath } from "../model.ts";
import { splitMarkdown } from "../frontmatter.ts";
import { parseYamlDocument } from "./document.ts";

export class YamlEdit extends Schema.Class<YamlEdit>("@usine/config/YamlEdit")({
  path: Schema.Array(Schema.NonEmptyString).check(Schema.isNonEmpty()),
  value: Schema.Json,
}) {}

/** Mutate one YAML path through the Document AST, retaining comments and key order. */
export const updateYaml = Effect.fn("YamlWriter.updateYaml")(
  (file: InstancePath, source: string, edit: YamlEdit): Effect.Effect<string, ConfigFileError> =>
    Effect.gen(function* () {
      const document = yield* parseYamlDocument(file, source);
      document.setIn(edit.path, edit.value);
      return document.toString();
    }),
);

/** Apply the same surgical mutation to the YAML half of a Markdown config file. */
export const updateFrontmatter = Effect.fn("YamlWriter.updateFrontmatter")(
  (file: InstancePath, source: string, edit: YamlEdit): Effect.Effect<string, ConfigFileError> =>
    Effect.gen(function* () {
      const markdown = yield* splitMarkdown(file, source);
      const updated = yield* updateYaml(file, markdown.yaml, edit);
      const withoutFinalNewline = updated.endsWith("\n") ? updated.slice(0, -1) : updated;
      const yaml =
        markdown.newline === "\r\n"
          ? withoutFinalNewline.replaceAll("\n", "\r\n")
          : withoutFinalNewline;
      return `---${markdown.newline}${yaml}${markdown.newline}---${markdown.newline}${markdown.body}`;
    }),
);
