import { Context, type Effect, Schema } from "effect";
import type { Environment } from "./environment.ts";

/**
 * The text of one CEL expression, such as a Loop's `if:` selection condition or
 * the inside of a `{{ }}` prompt interpolation. Decoding rejects empty and
 * whitespace-only text. Syntax and types are checked later, by an
 * {@link ExpressionEngine} operation against an {@link Environment}.
 */
export const Source = Schema.String.check(
  Schema.isPattern(/\S/u, { message: "Expected a non-blank CEL expression" }),
).pipe(Schema.brand("ExpressionSource"));
export type Source = typeof Source.Type;

const Position = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/**
 * The stage at which checking rejected an expression:
 *
 * - `parse_error`: the source is not valid CEL syntax.
 * - `type_error`: the source parses but names an unknown variable or field, or
 *   combines values of incompatible types.
 * - `unexpected_result_type`: the source type-checks but its result type does
 *   not fit the operation, such as a non-`bool` selection condition.
 * - `check_failed`: the CEL implementation rejected the {@link Environment}
 *   itself, for example a type name that no object type declares, or failed
 *   without a detail.
 */
export const CheckErrorCode = Schema.Literals([
  "check_failed",
  "parse_error",
  "type_error",
  "unexpected_result_type",
]);
export type CheckErrorCode = typeof CheckErrorCode.Type;

/**
 * The expression failed to parse, to type-check, or to produce the expected
 * result type. Checking reads only the {@link Environment}, never a payload, so
 * the same expression fails the same way until it or its Environment changes.
 */
export class ExpressionCheckError extends Schema.TaggedError<ExpressionCheckError>(
  "@usine/expression/ExpressionCheckError",
)("ExpressionCheckError", {
  source: Source,
  code: CheckErrorCode,
  message: Schema.NonEmptyString,
  position: Schema.Option(Position),
}) {}

/**
 * Evaluation failed on an expression that had already checked. The cause lies in
 * the values read at runtime: a root variable or object key is missing from
 * `context`, a value does not have its declared type, or an operation such as
 * division by zero or a list index out of range failed.
 */
export class ExpressionEvaluationError extends Schema.TaggedError<ExpressionEvaluationError>(
  "@usine/expression/ExpressionEvaluationError",
)("ExpressionEvaluationError", {
  source: Source,
  message: Schema.NonEmptyString,
}) {}

/**
 * Either failure an evaluating {@link ExpressionEngine} operation can return.
 * Match on `_tag` to tell a check failure from an evaluation failure.
 */
export const ExpressionError = Schema.Union([ExpressionCheckError, ExpressionEvaluationError]);
export type ExpressionError = typeof ExpressionError.Type;

/**
 * A value one prompt interpolation can render: a string, number, bigint,
 * boolean, or `null`. CEL `int` and `uint` results arrive as `bigint`, and CEL
 * `double` results as `number`.
 */
export const Scalar = Schema.Union([
  Schema.String,
  Schema.Number,
  Schema.BigInt,
  Schema.Boolean,
  Schema.Null,
]);
export type Scalar = typeof Scalar.Type;

/** Checks and evaluates the expressions used to select Items and fill Loop task templates. */
export interface ExpressionEngineService {
  /**
   * The string literals the expression compares against the `name` field of
   * values reached from `memberPath`, following macro bindings and collection
   * transformations. Config validation uses it to spot undeclared labels.
   */
  readonly relatedStringLiterals: (
    source: Source,
    memberPath: ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlyArray<string>, ExpressionCheckError>;
  /** Checks whether the expression can select Items, without evaluating a payload. */
  readonly checkBoolean: (
    source: Source,
    environment: Environment,
  ) => Effect.Effect<void, ExpressionCheckError>;
  /** Checks whether the expression can produce one value for prompt interpolation. */
  readonly checkScalar: (
    source: Source,
    environment: Environment,
  ) => Effect.Effect<void, ExpressionCheckError>;
  /** Checks and evaluates a selection condition; `context` supplies values for the environment's root variables. */
  readonly evaluateBoolean: (
    source: Source,
    environment: Environment,
    context: Schema.JsonObject,
  ) => Effect.Effect<boolean, ExpressionError>;
  /** Checks and evaluates a prompt interpolation; `context` supplies values for the environment's root variables. */
  readonly evaluateScalar: (
    source: Source,
    environment: Environment,
    context: Schema.JsonObject,
  ) => Effect.Effect<Scalar, ExpressionError>;
}

/**
 * The service tag for checking and evaluating Loop selection conditions and
 * prompt interpolations. Provide it with an adapter layer such as
 * `MarcbachmannCelLayer` from `@usine/expression/marcbachmann-cel`.
 */
export class ExpressionEngine extends Context.Service<ExpressionEngine, ExpressionEngineService>()(
  "@usine/expression/ExpressionEngine",
) {}

export { TypeReference, ObjectField, ObjectType, Variable, Environment } from "./environment.ts";
