import { Effect, Schema } from "effect";

/**
 * A CEL type name without spaces, such as `string`, `Label`, `list<T>`, or `map<K,V>`.
 * Decoding checks only the syntax; an undeclared object type fails when an expression is checked.
 */
export const TypeReference = Schema.String.check(
  Schema.isPattern(
    /^(?:[A-Za-z_][A-Za-z0-9_.]*|list<[A-Za-z_][A-Za-z0-9_.]*>|map<[A-Za-z_][A-Za-z0-9_.]*,[A-Za-z_][A-Za-z0-9_.]*>)$/u,
    { message: "Expected a CEL type reference" },
  ),
).pipe(Schema.brand("CelTypeReference"));
export type TypeReference = typeof TypeReference.Type;

const Identifier = Schema.String.check(
  Schema.isPattern(/^[A-Za-z_][A-Za-z0-9_]*$/u, { message: "Expected a CEL identifier" }),
);

const ObjectTypeName = Schema.String.check(
  Schema.isPattern(/^[A-Za-z_][A-Za-z0-9_.]*$/u, {
    message: "Expected a CEL object-type name",
  }),
);

const uniqueNames = (message: string) =>
  Schema.makeFilter<ReadonlyArray<{ readonly name: string }>>(
    (values) => new Set(values.map(({ name }) => name)).size === values.length,
    { message },
  );

/** A field of an {@link ObjectType}. If the field is nullable and its key is absent, it evaluates to `null`. */
export class ObjectField extends Schema.Class<ObjectField>("@usine/expression/ObjectField")({
  name: Identifier,
  /** The CEL type of a non-`null` value. */
  type: TypeReference,
  /** Whether the value can be `null` or absent. Reading an absent non-nullable field fails evaluation. */
  nullable: Schema.Boolean.pipe(Schema.withConstructorDefault(Effect.succeed(false))),
}) {}

/** An object type that expressions can read fields from, such as `IssuePayload`. */
export class ObjectType extends Schema.Class<ObjectType>("@usine/expression/ObjectType")({
  name: ObjectTypeName,
  fields: Schema.Array(ObjectField).check(uniqueNames("Expected unique CEL object-field names")),
}) {}

/** A root variable, such as `repo` or `item`, whose value is the `context` entry with the same name. */
export class Variable extends Schema.Class<Variable>("@usine/expression/Variable")({
  name: Identifier,
  type: TypeReference,
}) {}

/**
 * The types and root variables that expressions are checked and evaluated against. An
 * expression that references anything else fails checking.
 */
export class Environment extends Schema.Class<Environment>("@usine/expression/Environment")({
  /** The object types, each declared before any type whose fields reference it. */
  types: Schema.Array(ObjectType).check(uniqueNames("Expected unique CEL object-type names")),
  variables: Schema.Array(Variable).check(uniqueNames("Expected unique CEL variable names")),
}) {}
