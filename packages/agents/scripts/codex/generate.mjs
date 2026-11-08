import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { Schema } from "effect";
import { format } from "oxfmt";
import { CODEX_PROTOCOL } from "../../src/protocol/codex/version.ts";

const output = new URL("../../src/protocol/codex/generated.ts", import.meta.url);
const source = `https://raw.githubusercontent.com/openai/codex/${CODEX_PROTOCOL.commit}/codex-rs/app-server-protocol/schema/json/codex_app_server_protocol.schemas.json`;
const roots = [
  "ThreadResumeResponse",
  "ThreadStartResponse",
  "TurnStartResponse",
  "TurnCompletedNotification",
  "ItemStartedNotification",
  "ItemCompletedNotification",
  "ThreadTokenUsageUpdatedNotification",
  "AccountRateLimitsUpdatedNotification",
  "AccountUpdatedNotification",
  "ErrorNotification",
  "ModelListResponse",
  "GetAccountResponse",
  "AgentMessageDeltaNotification",
];
const declarations = new Map();
const visiting = new Set();
const response = await fetch(source, { signal: AbortSignal.timeout(60_000) });
assert(response.ok, `Fetching ${source}: HTTP ${response.status}`);
const document = Schema.decodeUnknownSync(
  Schema.Struct({
    $schema: Schema.Literal("http://json-schema.org/draft-07/schema#"),
    definitions: Schema.Struct({ v2: Schema.Record(Schema.String, Schema.Json) }),
  }),
)(await response.json());

function reference(ref) {
  assert.match(ref, /^#\/definitions\/v2\/\w+$/u);
  const name = ref.split("/").at(-1);
  if (declarations.has(name)) return name;
  assert(!visiting.has(name), `Recursive schema needs explicit support: ${name}`);
  visiting.add(name);
  const schema = document.definitions.v2[name];
  assert(schema, `Missing upstream definition: ${name}`);
  const expression = emit(schema);
  const values = enumValues(schema);
  if (values) declarations.set(`${name}Values`, `${JSON.stringify(values)} as const`);
  declarations.set(name, expression);
  visiting.delete(name);
  return name;
}

function enumValues(schema) {
  if (schema.enum) return schema.enum;
  const alternatives = schema.oneOf ?? schema.anyOf;
  if (!alternatives) return;
  const values = alternatives.map(enumValues);
  return values.every((value) => value !== undefined) ? values.flat() : undefined;
}

function union(members) {
  const expressions = [...new Set(members)];
  return expressions.length === 1 ? expressions[0] : `Schema.Union([${expressions.join(", ")}])`;
}

function emit(schema, propertyName) {
  if (schema === true) return "Schema.Json";
  if (schema === false) return "Schema.Never";
  assert(
    Schema.is(Schema.Record(Schema.String, Schema.Json))(schema),
    "Expected a JSON schema object",
  );
  if (schema.$ref) return reference(schema.$ref);
  if (schema.allOf) {
    assert.equal(schema.allOf.length, 1, "Only reference wrappers are supported");
    return emit(schema.allOf[0]);
  }
  if (schema.oneOf || schema.anyOf) {
    return union(
      (schema.oneOf ?? schema.anyOf).map((branch) => {
        const member = schema.properties
          ? {
              ...branch,
              properties: { ...schema.properties, ...branch.properties },
              required: [...(schema.required ?? []), ...(branch.required ?? [])],
            }
          : branch;
        if (member.title && member.type === "object") {
          const expression = emit(member);
          assert(!declarations.has(member.title), `Duplicate variant: ${member.title}`);
          declarations.set(member.title, expression);
          return member.title;
        }
        return emit(member);
      }),
    );
  }
  if (schema.enum) {
    assert(Schema.is(Schema.Array(Schema.String))(schema.enum), "Expected a string enum");
    // Discriminants stay literal; values such as statuses and phases accept new upstream members.
    return propertyName === "type" && schema.enum.length === 1
      ? `Schema.Literal(${JSON.stringify(schema.enum[0])})`
      : "Schema.String";
  }
  if (Array.isArray(schema.type)) {
    return union(schema.type.map((type) => emit({ ...schema, type })));
  }
  switch (schema.type) {
    case "string":
      return "Schema.String";
    case "integer":
    case "number":
      return "Schema.Finite";
    case "boolean":
      return "Schema.Boolean";
    case "null":
      return "Schema.Null";
    case "array":
      return `Schema.Array(${emit(schema.items)})`;
    case "object": {
      const fields = Object.entries(schema.properties ?? {}).map(([key, value]) => {
        const expression = emit(value, key);
        return `${JSON.stringify(key)}: ${schema.required?.includes(key) ? expression : `Schema.optionalKey(${expression})`}`;
      });
      const struct = `Schema.Struct({${fields.join(",\n")}})`;
      if (schema.additionalProperties && schema.additionalProperties !== true) {
        assert.equal(
          fields.length,
          0,
          "Objects with both fields and additional properties need explicit support",
        );
        return `Schema.Record(Schema.String, ${emit(schema.additionalProperties)})`;
      }
      return fields.length === 0 ? "Schema.Record(Schema.String, Schema.Json)" : struct;
    }
    default:
      assert.deepEqual(
        Object.keys(schema).filter((key) => !["description", "default", "title"].includes(key)),
        [],
      );
      return "Schema.Json";
  }
}

for (const name of roots) reference(`#/definitions/v2/${name}`);
const header = `// Generated by scripts/codex/generate.mjs. Do not edit.\n// Source: openai/codex; version and commit: ./version.ts.\n// String enums are open; tagged-union discriminants remain literals.\nimport { Schema } from "effect";\n\n`;
const code =
  header +
  [...declarations]
    .map(([name, expression]) => `export const ${name} = ${expression};\n`)
    .join("\n");
const formatted = await format("generated.ts", code);
assert.equal(formatted.errors.length, 0, JSON.stringify(formatted.errors));
if (process.argv.includes("--check")) {
  assert(
    (await readFile(output, "utf8")) === formatted.code,
    "Codex schemas are stale. Run pnpm --filter @usine/agents codex:generate",
  );
} else {
  await writeFile(output, formatted.code);
}
