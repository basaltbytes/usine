import { Schema } from "effect";

/** Non-blank CEL source text. */
export const Source = Schema.String.check(
  Schema.isPattern(/\S/u, { message: "Expected a non-blank CEL expression" }),
).pipe(Schema.brand("ExpressionSource"));
export type Source = typeof Source.Type;

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

export class ObjectField extends Schema.Class<ObjectField>("@usine/expression/ObjectField")({
  name: Identifier,
  type: TypeReference,
}) {}

/** A CEL object type. Declare a type before the types that reference it. */
export class ObjectType extends Schema.Class<ObjectType>("@usine/expression/ObjectType")({
  name: ObjectTypeName,
  fields: Schema.Array(ObjectField).check(uniqueNames("Expected unique CEL object-field names")),
}) {}

export class Variable extends Schema.Class<Variable>("@usine/expression/Variable")({
  name: Identifier,
  type: TypeReference,
}) {}

/** The types and root variables an expression is checked and evaluated against. */
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

/** The expression failed to parse, to type-check, or to produce the expected result type. */
export class ExpressionCheckError extends Schema.TaggedError<ExpressionCheckError>(
  "@usine/expression/ExpressionCheckError",
)("ExpressionCheckError", {
  source: Source,
  code: CheckErrorCode,
  message: Schema.NonEmptyString,
  position: Schema.Option(Position),
}) {}

/** Evaluation failed on an expression that had already checked. */
export class ExpressionEvaluationError extends Schema.TaggedError<ExpressionEvaluationError>(
  "@usine/expression/ExpressionEvaluationError",
)("ExpressionEvaluationError", {
  source: Source,
  message: Schema.NonEmptyString,
}) {}

export const ExpressionError = Schema.Union([ExpressionCheckError, ExpressionEvaluationError]);
export type ExpressionError = typeof ExpressionError.Type;

/** Values prompt interpolation can render. CEL ints stay bigint. */
export const Scalar = Schema.Union([
  Schema.String,
  Schema.Number,
  Schema.BigInt,
  Schema.Boolean,
  Schema.Null,
]);
export type Scalar = typeof Scalar.Type;
