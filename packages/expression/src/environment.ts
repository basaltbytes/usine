import { Effect, Schema } from "effect";

/**
 * A type name in CEL syntax: a primitive such as `string` or `int`, an object
 * type such as `Label`, `list<T>`, or `map<K,V>`, with no spaces. Decoding checks
 * the syntax only. A name that no {@link ObjectType} declares fails when an
 * expression is checked.
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

/**
 * One named field and its CEL type within an object descriptor. A nullable
 * field holds `null` or a value of its type, and an absent key reads as `null`.
 * Expressions can compare it with `null`, while reads below it stay typed.
 */
export class ObjectField extends Schema.Class<ObjectField>("@usine/expression/ObjectField")({
  name: Identifier,
  type: TypeReference,
  nullable: Schema.Boolean.pipe(Schema.withConstructorDefault(Effect.succeed(false))),
}) {}

/**
 * A named object type expressions can read fields from, such as the
 * `IssuePayload` type of a payload slice. Declare a type before the types that
 * reference it. Field names must be unique within the type.
 */
export class ObjectType extends Schema.Class<ObjectType>("@usine/expression/ObjectType")({
  name: ObjectTypeName,
  fields: Schema.Array(ObjectField).check(uniqueNames("Expected unique CEL object-field names")),
}) {}

/**
 * A root variable available to CEL expressions in an {@link Environment}, such
 * as `repo` or `item`. Evaluation reads its value from the `context` entry of
 * the same name.
 */
export class Variable extends Schema.Class<Variable>("@usine/expression/Variable")({
  name: Identifier,
  type: TypeReference,
}) {}

/**
 * The types and root variables an expression is checked and evaluated against.
 * Object-type names and variable names must each be unique. Expressions that
 * name anything outside this environment fail checking.
 */
export class Environment extends Schema.Class<Environment>("@usine/expression/Environment")({
  types: Schema.Array(ObjectType).check(uniqueNames("Expected unique CEL object-type names")),
  variables: Schema.Array(Variable).check(uniqueNames("Expected unique CEL variable names")),
}) {}
