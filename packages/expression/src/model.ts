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

const uniqueNames = (message: string) =>
  Schema.makeFilter<ReadonlyArray<{ readonly name: string }>>(
    (values) => new Set(values.map(({ name }) => name)).size === values.length,
    { message },
  );

/** One field in a backend-neutral CEL object-type declaration. */
export class ObjectField extends Schema.Class<ObjectField>("@usine/expression/ObjectField")({
  name: Identifier,
  type: TypeReference,
}) {}

/** A CEL object type. Types are registered in declaration order. */
export class ObjectType extends Schema.Class<ObjectType>("@usine/expression/ObjectType")({
  name: ObjectTypeName,
  fields: Schema.Array(ObjectField).check(uniqueNames("Expected unique CEL object-field names")),
}) {}

/** One root variable available to a CEL expression. */
export class Variable extends Schema.Class<Variable>("@usine/expression/Variable")({
  name: Identifier,
  type: TypeReference,
}) {}

/** The checked namespace for one expression family, expressed in CEL's type vocabulary. */
export class Environment extends Schema.Class<Environment>("@usine/expression/Environment")({
  types: Schema.Array(ObjectType).check(uniqueNames("Expected unique CEL object-type names")),
  variables: Schema.Array(Variable).check(uniqueNames("Expected unique CEL variable names")),
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
export class ExpressionCheckError extends Schema.TaggedError<ExpressionCheckError>(
  "@usine/expression/ExpressionCheckError",
)("ExpressionCheckError", {
  source: Source,
  code: CheckErrorCode,
  message: Schema.NonEmptyString,
  position: Schema.Option(Position),
}) {}

/** Typed failure from evaluating an expression that previously checked. */
export class ExpressionEvaluationError extends Schema.TaggedError<ExpressionEvaluationError>(
  "@usine/expression/ExpressionEvaluationError",
)("ExpressionEvaluationError", {
  source: Source,
  message: Schema.NonEmptyString,
}) {}

/** Every failure mode this package's service can produce. */
export const ExpressionError = Schema.Union([ExpressionCheckError, ExpressionEvaluationError]);
export type ExpressionError = typeof ExpressionError.Type;

/** Values admitted by prompt interpolation. CEL ints deliberately remain bigint here. */
export const Scalar = Schema.Union([
  Schema.String,
  Schema.Number,
  Schema.BigInt,
  Schema.Boolean,
  Schema.Null,
]);
export type Scalar = typeof Scalar.Type;
