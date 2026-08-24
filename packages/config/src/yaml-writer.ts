import { Effect, Schema } from "effect";
import { parseDocument } from "yaml";
import { ConfigFileError } from "./errors.ts";
import { splitMarkdown } from "./frontmatter.ts";

const causeMessage = (cause: unknown): string =>
  cause instanceof Error && cause.message.length > 0
    ? cause.message
    : "Unknown YAML parsing failure";

export class YamlEdit extends Schema.Class<YamlEdit>("Config/YamlEdit")({
  path: Schema.Array(Schema.NonEmptyString).check(Schema.isNonEmpty()),
  value: Schema.Json,
}) {}

/** Mutate one YAML path through the Document AST, retaining comments and key order. */
export const updateYaml = Effect.fn("YamlWriter.updateYaml")(
  (file: string, source: string, edit: YamlEdit): Effect.Effect<string, ConfigFileError> =>
    Effect.gen(function* () {
      const document = yield* Effect.try({
        try: () =>
          parseDocument(source, {
            keepSourceTokens: true,
            prettyErrors: true,
            strict: true,
            uniqueKeys: true,
          }),
        catch: (cause) =>
          new ConfigFileError({ file, stage: "yaml", message: causeMessage(cause) }),
      });
      const syntaxIssue = document.errors[0] ?? document.warnings[0];
      if (syntaxIssue !== undefined) {
        return yield* new ConfigFileError({
          file,
          stage: "yaml",
          message: syntaxIssue.message,
        });
      }
      document.setIn(edit.path, edit.value);
      return document.toString();
    }),
);

/** Apply the same surgical mutation to the YAML half of a Markdown config file. */
export const updateFrontmatter = Effect.fn("YamlWriter.updateFrontmatter")(
  (file: string, source: string, edit: YamlEdit): Effect.Effect<string, ConfigFileError> =>
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
