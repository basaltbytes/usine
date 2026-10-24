import { Schema } from "effect";

export type ToolSection =
  | {
      readonly _tag: "Code";
      readonly label: string;
      readonly text: string;
      readonly language: "bash" | "text" | "diff" | "typescript" | "json";
    }
  | { readonly _tag: "Text"; readonly label: string; readonly text: string }
  | {
      readonly _tag: "Fields";
      readonly label: string;
      readonly fields: ReadonlyArray<{ readonly label: string; readonly value: Schema.Json }>;
    };

export const JsonObject = Schema.Record(Schema.String, Schema.Json);
const TextBlock = Schema.Struct({
  type: Schema.Literals(["text", "inputText"]),
  text: Schema.String,
});
export const object = (value: Schema.Json | undefined): typeof JsonObject.Type =>
  Schema.is(JsonObject)(value) ? value : {};
export const string = (value: Schema.Json | undefined): string | undefined =>
  Schema.is(Schema.String)(value) ? value : undefined;
const label = (key: string): string => {
  if (key === "cwd") return "Working directory";
  if (key === "durationMs") return "Duration (ms)";
  const words = key
    .replace(/([a-z])([A-Z])/gu, "$1 $2")
    .replaceAll("_", " ")
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
};
export const code = (
  label: string,
  text: string,
  language: Extract<ToolSection, { readonly _tag: "Code" }>["language"] = "text",
): ToolSection => ({ _tag: "Code", label, text, language });
export const fields = (
  title: string,
  value: typeof JsonObject.Type,
  omitted: ReadonlyArray<string> = [],
): ReadonlyArray<ToolSection> => {
  const entries = Object.entries(value)
    .filter(([key]) => !omitted.includes(key))
    .map(([key, value]) => ({ label: label(key), value }));
  return entries.length === 0 ? [] : [{ _tag: "Fields", label: title, fields: entries }];
};
// Accepts Pi's `{ content, details }`, Claude's bare content, and Codex dynamic tool `inputText`
// blocks; any other value becomes labeled fields.
export const content = (
  value: Schema.Json | undefined,
  title: string,
  language: Extract<ToolSection, { readonly _tag: "Code" }>["language"] = "text",
): ReadonlyArray<ToolSection> => {
  if (value === undefined || value === null) return [];
  if (Schema.is(Schema.String)(value)) return [code(title, value, language)];
  if (Array.isArray(value))
    return value.flatMap((block) =>
      Schema.is(TextBlock)(block)
        ? [code(title, block.text, language)]
        : content(block, title, language),
    );
  if (!Schema.is(JsonObject)(value))
    return [{ _tag: "Fields", label: title, fields: [{ label: "Value", value }] }];
  const sections: Array<ToolSection> = [];
  const remaining: Record<string, Schema.Json> = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === "content" && Array.isArray(item)) sections.push(...content(item, title, language));
    else if (["text", "stdout", "stderr", "aggregatedOutput", "message"].includes(key))
      sections.push(...content(item, key === "text" ? title : label(key), language));
    else if (key === "error") sections.push(...content(item, "Error"));
    else remaining[key] = item;
  }
  return [...sections, ...fields(title, remaining)];
};
