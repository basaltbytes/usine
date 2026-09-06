import { Option, Schema } from "effect";
import type { ToolPresentation } from "./presentation.ts";
import { code, content, fields, object, string, type ToolSection } from "./sections.ts";

const Edit = Schema.Struct({ oldText: Schema.String, newText: Schema.String });
const FileChange = Schema.Struct({
  path: Schema.String,
  diff: Schema.String,
  kind: Schema.Struct({ type: Schema.String }),
});
const fileChanges = Schema.decodeUnknownOption(Schema.Array(FileChange));

const fileLanguage = (path: string): Extract<ToolSection, { readonly _tag: "Code" }>["language"] =>
  /\.[cm]?tsx?$/iu.test(path) ? "typescript" : /\.json$/iu.test(path) ? "json" : "text";

const confirmation = (output: Schema.Json | undefined): ReadonlyArray<ToolSection> =>
  content(output, "Confirmation").map((section) =>
    section._tag === "Code" ? { _tag: "Text", label: section.label, text: section.text } : section,
  );

/** Presents file operations using recorded contents and patches, with replacements as the fallback. */
export const presentFile = (
  input: Schema.Json | undefined,
  output: Schema.Json | undefined,
  action: "read" | "edit" | "write",
): Omit<ToolPresentation, "category"> => {
  const request = object(input);
  const result = object(output);
  const changes = fileChanges(result.changes ?? request.changes);
  const path = string(request.path) ?? string(request.file_path);
  const patch = string(object(result.details).patch) ?? string(object(result.details).diff);
  const edits = Schema.decodeUnknownOption(Schema.Array(Edit))(request.edits);
  const replacements = Option.getOrElse(edits, () =>
    Schema.is(Schema.String)(request.old_string) && Schema.is(Schema.String)(request.new_string)
      ? [{ oldText: request.old_string, newText: request.new_string }]
      : [],
  );
  return {
    title: { read: "Read file", edit: "Edit file", write: "Write file" }[action],
    subject:
      path ??
      Option.match(changes, {
        onNone: () => "File details unavailable",
        onSome: (files) =>
          files.length === 1
            ? (files[0]?.path ?? "File details unavailable")
            : `${files.length} files`,
      }),
    input: [
      ...fields("Options", request, [
        "path",
        "file_path",
        "edits",
        "old_string",
        "new_string",
        "content",
        "changes",
        "type",
        "id",
        "status",
      ]),
      ...(patch === undefined ? replacements : []).flatMap(({ oldText, newText }, index) => [
        code(
          replacements.length === 1 ? "Before" : `Before ${index + 1}`,
          oldText,
          fileLanguage(path ?? ""),
        ),
        code(
          replacements.length === 1 ? "After" : `After ${index + 1}`,
          newText,
          fileLanguage(path ?? ""),
        ),
      ]),
      ...(Schema.is(Schema.String)(request.content)
        ? [code("Content", request.content, fileLanguage(path ?? ""))]
        : []),
      ...(output === undefined
        ? Option.match(fileChanges(request.changes), {
            onNone: () => [],
            onSome: (files) => files.map(({ path, diff }) => code(path, diff, "diff")),
          })
        : []),
    ],
    output: Option.match(fileChanges(result.changes), {
      onNone: () =>
        patch !== undefined
          ? [
              code(path ?? "Changes", patch, "diff"),
              ...confirmation(
                Object.fromEntries(Object.entries(result).filter(([key]) => key !== "details")),
              ),
              ...fields("Metadata", object(result.details), ["patch", "diff"]),
            ]
          : action === "read"
            ? content(output, path ?? "Output", fileLanguage(path ?? ""))
            : confirmation(output),
      onSome: (files) =>
        files.map(({ path, diff, kind }) => code(`${path} · ${kind.type}`, diff, "diff")),
    }),
  };
};
