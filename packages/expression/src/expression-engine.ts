import { Context, type Effect, Schema } from "effect";
import type { Environment } from "./environment.ts";

/** Non-blank CEL source text. */
export const Source = Schema.String.check(
  Schema.isPattern(/\S/u, { message: "Expected a non-blank CEL expression" }),
).pipe(Schema.brand("ExpressionSource"));
export type Source = typeof Source.Type;

const Position = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/** Whether checking failed during parsing, type resolution, or result-type validation. */
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

/** The failures callers can receive when checking or evaluating a CEL expression. */
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

/** Evaluates Loop conditions and prompt expressions against their declared payload context. */
export class ExpressionEngine extends Context.Service<ExpressionEngine, ExpressionEngineService>()(
  "@usine/expression/ExpressionEngine",
) {}

export { TypeReference, ObjectField, ObjectType, Variable, Environment } from "./environment.ts";
