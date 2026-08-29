import { Effect, Option, Schema } from "effect";
import { type Document, parseDocument } from "yaml";
import { ConfigFileError, type InstancePath } from "../model.ts";

const causeMessage = (cause: unknown): string =>
  Option.match(
    Schema.decodeUnknownOption(Schema.Struct({ message: Schema.NonEmptyString }))(cause),
    {
      onNone: () => "Unknown YAML parsing failure",
      onSome: ({ message }) => message,
    },
  );

/**
 * Parse YAML source into its Document AST, strictly (unique keys, warnings
 * are errors), with source tokens retained so surgical edits keep formatting.
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
      catch: (cause) => new ConfigFileError({ file, stage: "yaml", message: causeMessage(cause) }),
    });
    const syntaxIssue = document.errors[0] ?? document.warnings[0];
    if (syntaxIssue !== undefined) {
      return yield* new ConfigFileError({
        file,
        stage: "yaml",
        message: syntaxIssue.message,
      });
    }
    return document;
  });
