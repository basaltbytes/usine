import assert from "node:assert/strict";
import { Schema } from "effect";

const isJsonObject = Schema.is(Schema.Record(Schema.String, Schema.Json));

/**
 * Returns Effect Schema expressions by export name for `roots` and every definition they reference.
 * Throws an assertion error for a schema shape that the generator can't translate faithfully.
 */
export function emitDeclarations(definitions, roots) {
  const declarations = new Map();
  const definitionsEmitted = new Set();
  const visiting = new Set();

  function declare(name, expression) {
    assert(!declarations.has(name), `Two schemas share the export name ${name}`);
    declarations.set(name, expression);
  }

  function definition(ref) {
    assert.match(ref, /^#\/definitions\/v2\/\w+$/u);
    const name = ref.split("/").at(-1);
    const schema = definitions[name];
    assert(schema, `Missing upstream definition: ${name}`);
    return { name, schema };
  }

  function reference(ref) {
    const { name, schema } = definition(ref);
    if (definitionsEmitted.has(name)) return name;
    assert(!visiting.has(name), `Recursive schema needs explicit support: ${name}`);
    visiting.add(name);
    const expression = emit(schema);
    const values = enumValues(schema);
    if (values) declare(`${name}Values`, `${JSON.stringify(values)} as const`);
    declare(name, expression);
    definitionsEmitted.add(name);
    visiting.delete(name);
    return name;
  }

  function assertVariantTag(schema, seen = new Set()) {
    assert(!seen.has(schema), "Recursive variant wrapper needs explicit support");
    seen.add(schema);
    if (schema.$ref) return assertVariantTag(definition(schema.$ref).schema, seen);
    if (schema.allOf) {
      assert.equal(schema.allOf.length, 1, "Only reference wrappers are supported");
      return assertVariantTag(schema.allOf[0], seen);
    }
    const tag = schema.properties?.type;
    if (tag !== undefined) {
      assert(
        Array.isArray(tag.enum) && tag.enum.length === 1,
        `Variant ${schema.title ?? "without a title"} needs an inline single-value type tag`,
      );
    }
  }

  function emit(schema, propertyName) {
    if (schema === true) return "Schema.Json";
    if (schema === false) return "Schema.Never";
    assert(isJsonObject(schema), "Expected a JSON schema object");
    assert(!("const" in schema), "const schemas need explicit support");
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
          assertVariantTag(member);
          if (member.title && member.type === "object") {
            declare(member.title, emit(member));
            return member.title;
          }
          return emit(member);
        }),
      );
    }
    if (schema.enum) {
      assert(Schema.is(Schema.Array(Schema.String))(schema.enum), "Expected a string enum");
      assert(
        schema.type === undefined || schema.type === "string",
        `Enums of type ${JSON.stringify(schema.type)} need explicit support`,
      );
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
  return declarations;
}

/** Returns the string enum members of `schema`, including those of its enum alternatives. */
function enumValues(schema) {
  if (schema.enum) return schema.enum;
  const alternatives = schema.oneOf ?? schema.anyOf;
  if (!alternatives) return;
  const values = alternatives.flatMap((alternative) => enumValues(alternative) ?? []);
  return values.length > 0 ? values : undefined;
}

function union(members) {
  const expressions = [...new Set(members)];
  return expressions.length === 1 ? expressions[0] : `Schema.Union([${expressions.join(", ")}])`;
}
