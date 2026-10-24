import { Effect, Option, Schema } from "effect";
import { type Document, parseDocument } from "yaml";
import { ConfigFileError, type InstancePath } from "../file.ts";

const causeMessage = (cause: unknown): string =>
  Option.match(
    Schema.decodeUnknownOption(Schema.Struct({ message: Schema.NonEmptyString }))(cause),
    {
      onNone: () => "The YAML parser failed without an error message",
      onSome: ({ message }) => message,
    },
  );

/**
 * Parses YAML into a Document that keeps source tokens, so edits preserve formatting. Fails on
 * duplicate keys and parser warnings.
 */
export const parseYamlDocument = (
  file: InstancePath,
  source: string,
): Effect.Effect<Document.Parsed, ConfigFileError> =>
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
        new ConfigFileError({
          file,
          stage: "yaml",
          expression: Option.none(),
          message: causeMessage(cause),
        }),
    });
    const syntaxIssue = document.errors[0] ?? document.warnings[0];
    if (syntaxIssue !== undefined) {
      return yield* new ConfigFileError({
        file,
        stage: "yaml",
        expression: Option.none(),
        message: syntaxIssue.message,
      });
    }
    return document;
  });
