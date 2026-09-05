import { Schema } from "effect";

/** A type name in CEL syntax such as `string`, `Issue`, or `list<Label>`. */
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

/** One named field and its CEL type within an object descriptor. */
export class ObjectField extends Schema.Class<ObjectField>("@usine/expression/ObjectField")({
  name: Identifier,
  type: TypeReference,
}) {}

/** A CEL object type. Declare a type before the types that reference it. */
export class ObjectType extends Schema.Class<ObjectType>("@usine/expression/ObjectType")({
  name: ObjectTypeName,
  fields: Schema.Array(ObjectField).check(uniqueNames("Expected unique CEL object-field names")),
}) {}

/** A root variable available to CEL expressions in an Environment. */
export class Variable extends Schema.Class<Variable>("@usine/expression/Variable")({
  name: Identifier,
  type: TypeReference,
}) {}

/** The types and root variables an expression is checked and evaluated against. */
export class Environment extends Schema.Class<Environment>("@usine/expression/Environment")({
  types: Schema.Array(ObjectType).check(uniqueNames("Expected unique CEL object-type names")),
  variables: Schema.Array(Variable).check(uniqueNames("Expected unique CEL variable names")),
}) {}
