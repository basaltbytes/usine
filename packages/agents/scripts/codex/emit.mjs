import assert from "node:assert/strict";
import { Schema } from "effect";

const isJsonObject = Schema.is(Schema.Record(Schema.String, Schema.Json));
const isStringArray = Schema.is(Schema.Array(Schema.String));
const ANNOTATIONS = ["$schema", "title", "description", "default"];

/**
 * Returns Effect Schema expressions by export name for `roots` and every definition they reference.
 * Throws an assertion error for a schema shape that the generator doesn't support, such as union
 * variants that a decoder couldn't tell apart.
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

  /** Returns the schema that a `$ref` or single-`allOf` wrapper stands for, or `undefined`. */
  function unwrap(schema) {
    if (schema.$ref) {
      assertSiblings(schema, ["$ref"], "Wrapper sibling constraints need explicit support");
      return definition(schema.$ref).schema;
    }
    if (schema.allOf) {
      assertSiblings(schema, ["allOf"], "Wrapper sibling constraints need explicit support");
      assert.equal(schema.allOf.length, 1, "Only reference wrappers are supported");
      return schema.allOf[0];
    }
  }

  /** Returns the schema behind any chain of wrappers around `schema`. */
  function resolve(schema) {
    const seen = new Set();
    let target = schema;
    for (let inner = unwrap(target); inner !== undefined; inner = unwrap(target)) {
      assert(!seen.has(inner), "Recursive variant wrapper needs explicit support");
      seen.add(inner);
      target = inner;
    }
    return target;
  }

  /** Returns the string members of `schema` and of its enum alternatives, or `undefined`. */
  function enumValues(schema) {
    if (schema.enum) return schema.enum;
    const alternatives = schema.oneOf ?? schema.anyOf;
    if (!alternatives) return;
    const values = alternatives.flatMap((alternative) => {
      const target = resolve(alternative);
      return isObjectSchema(target) ? [] : (enumValues(target) ?? []);
    });
    return values.length > 0 ? [...new Set(values)] : undefined;
  }

  /**
   * Rejects variants that `Schema.Union` would not tell apart. Decoding keeps the first matching
   * member and drops the keys it doesn't declare, so a variant must not accept a later one's values.
   */
  function assertDistinguishable(members) {
    const variants = members.flatMap((member) => leaves(member, new Set()));
    if (variants.length < 2) return;
    const objects = variants.filter(
      ({ target }) => isObjectSchema(target) || acceptsEveryObject(target),
    );
    const fallback = objects.at(-1);
    const tagKeys = new Set(
      objects.flatMap(({ target }) =>
        Object.entries(target.properties ?? {})
          .filter(([, property]) => isTag(property))
          .map(([key]) => key),
      ),
    );
    for (const { name, target } of objects) {
      for (const key of tagKeys) {
        const property = target.properties?.[key];
        if (property === undefined) continue;
        assert(isTag(property), `Variant ${name} needs an inline single-value ${key} tag`);
        assert(target.required?.includes(key), `Variant ${name} needs a required ${key} tag`);
      }
    }
    for (const [index, earlier] of objects.entries()) {
      for (const later of objects.slice(index + 1)) {
        const tagged = [...tagKeys].some((key) => {
          const [first, second] = [earlier, later].map(({ target }) => target.properties?.[key]);
          return isTag(first) && isTag(second) && first.enum[0] !== second.enum[0];
        });
        // A later variant without fields generates a record or `Schema.Json`, which accepts every key.
        const fields = later.target.properties ?? {};
        const covered =
          Object.keys(fields).length === 0 ||
          (earlier.target.required ?? []).every((key) => key in fields);
        // A last variant that accepts every object may catch the unknown variants of an externally
        // tagged enum. Its earlier variants each declare one required key and no other key.
        const tagsByKey =
          later === fallback && acceptsEveryObject(later.target) && isKeyTagged(earlier.target);
        assert(
          tagged || tagsByKey || !covered,
          `Variant ${earlier.name} accepts the values of variant ${later.name}; they need distinct tags`,
        );
      }
    }
  }

  /**
   * Returns the non-null alternatives that `member` decodes as, in decoding order. A member that
   * resolves to a nested union contributes the alternatives of that union.
   */
  function leaves(member, seen) {
    if (isNull(member)) return [];
    const target = resolve(member);
    const alternatives = target.oneOf ?? target.anyOf;
    if (!alternatives)
      return isNull(target)
        ? []
        : [{ name: target.title ?? member.title ?? "without a title", target }];
    assert(!seen.has(target), "Recursive union needs explicit support");
    const path = new Set([...seen, target]);
    return alternatives.flatMap((branch) => leaves(mergeCommon(target, branch), path));
  }

  function emit(schema) {
    if (schema === true) return "Schema.Json";
    if (schema === false) return "Schema.Never";
    assert(isJsonObject(schema), "Expected a JSON schema object");
    assert(!("const" in schema), "const schemas need explicit support");
    const inner = unwrap(schema);
    if (schema.$ref) return reference(schema.$ref);
    if (inner !== undefined) return emit(inner);
    if (schema.oneOf || schema.anyOf) {
      assert(!(schema.oneOf && schema.anyOf), "Simultaneous oneOf and anyOf need explicit support");
      const keyword = schema.oneOf ? "oneOf" : "anyOf";
      assertSiblings(
        schema,
        schema.properties ? [keyword, "properties", "required", "type"] : [keyword],
        "Union sibling constraints need explicit support",
      );
      assert(
        schema.type === undefined || schema.type === "object",
        "Union sibling constraints need explicit support",
      );
      const members = schema[keyword].map((branch) => mergeCommon(schema, branch));
      assertDistinguishable(members);
      return union(
        members.map((member) => {
          if (member.title && member.type === "object") {
            declare(member.title, emit(member));
            return member.title;
          }
          return emit(member);
        }),
      );
    }
    if (schema.enum) {
      assert(isStringArray(schema.enum), "Expected a string enum");
      assert(
        schema.type === undefined || schema.type === "string",
        `Enums of type ${JSON.stringify(schema.type)} need explicit support`,
      );
      // String enums are open, so values such as statuses and phases accept new upstream members.
      return "Schema.String";
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
          // Single-value enums are tags, which stay literal.
          const expression = isTag(value)
            ? `Schema.Literal(${JSON.stringify(value.enum[0])})`
            : emit(value);
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
          Object.keys(schema).filter((key) => !ANNOTATIONS.includes(key)),
          [],
        );
        return "Schema.Json";
    }
  }

  for (const name of roots) reference(`#/definitions/v2/${name}`);
  return declarations;
}

/** Returns `branch` of the union `schema` with the union's common properties and required keys. */
function mergeCommon(schema, branch) {
  if (!schema.properties) return branch;
  assert(!isNull(branch), "A null alternative beside common properties needs explicit support");
  return {
    ...branch,
    properties: { ...schema.properties, ...branch.properties },
    required: [...(schema.required ?? []), ...(branch.required ?? [])],
  };
}

/** Returns whether `schema` is an inline enum of one string, the shape of a union tag. */
function isTag(schema) {
  return (
    isJsonObject(schema) &&
    isStringArray(schema.enum) &&
    schema.enum.length === 1 &&
    (schema.type === undefined || schema.type === "string") &&
    !schema.$ref &&
    !schema.allOf
  );
}

function isNull(schema) {
  return schema.type === "null" || (Array.isArray(schema.type) && schema.type.join() === "null");
}

/**
 * Returns whether `schema` generates a record or `Schema.Json`: `true`, a schema without a type or
 * an enum, or a schema whose types include `object` and that declares no fields.
 */
function acceptsEveryObject(schema) {
  if (schema === true) return true;
  if (!isJsonObject(schema) || Object.keys(schema.properties ?? {}).length > 0) return false;
  if (schema.type === undefined) return schema.enum === undefined;
  return [schema.type].flat().includes("object");
}

/** Returns whether `schema` is an object of one required key and no additional keys. */
function isKeyTagged(schema) {
  const keys = Object.keys(schema.properties ?? {});
  return (
    schema.additionalProperties === false &&
    keys.length === 1 &&
    schema.required?.length === 1 &&
    schema.required[0] === keys[0]
  );
}

function isObjectSchema(schema) {
  return isJsonObject(schema) && (schema.type === "object" || schema.properties !== undefined);
}

function union(members) {
  const expressions = [...new Set(members)];
  return expressions.length === 1 ? expressions[0] : `Schema.Union([${expressions.join(", ")}])`;
}

function assertSiblings(schema, keywords, message) {
  assert.deepEqual(
    Object.keys(schema).filter((key) => !keywords.includes(key) && !ANNOTATIONS.includes(key)),
    [],
    message,
  );
}
