import { Schema } from "effect";

/** CEL source accepted at the config boundary. */
export const Source = Schema.String.check(
  Schema.isPattern(/\S/u, { message: "Expected a non-blank CEL expression" }),
).pipe(Schema.brand("ExpressionSource"));
export type Source = typeof Source.Type;

/** A CEL-spec type reference such as `string`, `Issue`, or `list<Label>`. */
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

/** One field in a backend-neutral CEL object-type declaration. */
export class ObjectField extends Schema.Class<ObjectField>("Expression/ObjectField")({
  name: Identifier,
  type: TypeReference,
}) {}

/** A CEL object type. Types are registered in declaration order. */
export class ObjectType extends Schema.Class<ObjectType>("Expression/ObjectType")({
  name: ObjectTypeName,
  fields: Schema.Array(ObjectField).check(
    Schema.makeFilter((fields) => new Set(fields.map(({ name }) => name)).size === fields.length, {
      message: "Expected unique CEL object-field names",
    }),
  ),
}) {}

/** One root variable available to a CEL expression. */
export class Variable extends Schema.Class<Variable>("Expression/Variable")({
  name: Identifier,
  type: TypeReference,
}) {}

/** The checked namespace for one expression family, expressed in CEL's type vocabulary. */
export class Environment extends Schema.Class<Environment>("Expression/Environment")({
  types: Schema.Array(ObjectType).check(
    Schema.makeFilter((types) => new Set(types.map(({ name }) => name)).size === types.length, {
      message: "Expected unique CEL object-type names",
    }),
  ),
  variables: Schema.Array(Variable).check(
    Schema.makeFilter(
      (variables) => new Set(variables.map(({ name }) => name)).size === variables.length,
      { message: "Expected unique CEL variable names" },
    ),
  ),
}) {}

const Position = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

export const CheckErrorCode = Schema.Literals([
  "check_failed",
  "parse_error",
  "type_error",
  "unexpected_result_type",
]);
export type CheckErrorCode = typeof CheckErrorCode.Type;

/** Typed failure from CEL parsing, type checking, or expected-result checking. */
export class CheckError extends Schema.TaggedError<CheckError>("Expression/CheckError")(
  "ExpressionCheckError",
  {
    source: Source,
    code: CheckErrorCode,
    message: Schema.NonEmptyString,
    position: Schema.Option(Position),
  },
) {}

/** Typed failure from evaluating an expression that previously checked. */
export class EvaluationError extends Schema.TaggedError<EvaluationError>(
  "Expression/EvaluationError",
)("ExpressionEvaluationError", {
  source: Source,
  message: Schema.NonEmptyString,
}) {}

/** Values admitted by prompt interpolation. CEL ints deliberately remain bigint here. */
export const Scalar = Schema.Union([
  Schema.String,
  Schema.Number,
  Schema.BigInt,
  Schema.Boolean,
  Schema.Null,
]);
export type Scalar = typeof Scalar.Type;
