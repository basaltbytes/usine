import { Context, type Effect, type Result, Schema } from "effect";
import type { Environment } from "./environment.ts";

/**
 * The text of a CEL expression, such as a Loop's `if:` condition or a `{{ }}` interpolation.
 * Decoding rejects blank text; {@link ExpressionEngine} checks syntax and types.
 */
export const Source = Schema.String.check(
  Schema.isPattern(/\S/u, { message: "Expected a non-blank CEL expression" }),
).pipe(Schema.brand("ExpressionSource"));
export type Source = typeof Source.Type;

const Position = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/**
 * - `parse_error`: the source is not valid CEL syntax.
 * - `type_error`: the source references an unknown variable or field, or combines
 *   incompatible types.
 * - `unexpected_result_type`: the result type is wrong for the operation, such as a non-`bool`
 *   selection condition.
 * - `check_failed`: the CEL implementation rejected the {@link Environment} itself, such as an
 *   undeclared type name, or failed without a detail.
 */
export const CheckErrorCode = Schema.Literals([
  "check_failed",
  "parse_error",
  "type_error",
  "unexpected_result_type",
]);
export type CheckErrorCode = typeof CheckErrorCode.Type;

/** An error from checking an expression against an {@link Environment}; checking never reads a payload. */
export class ExpressionCheckError extends Schema.TaggedError<ExpressionCheckError>(
  "@usine/expression/ExpressionCheckError",
)("ExpressionCheckError", {
  source: Source,
  code: CheckErrorCode,
  /**
   * A human-readable description, possibly multi-line with a marked excerpt of `source`. The
   * wording isn't stable; branch on `code`.
   */
  message: Schema.NonEmptyString,
  /**
   * The zero-based offset in `source` where the failure starts. Always `None` for
   * `unexpected_result_type` and `check_failed`.
   */
  position: Schema.Option(Position),
}) {}

/**
 * An error from evaluating a checked expression, such as a missing `context` key, a value of the
 * wrong type, division by zero, or an out-of-range list index.
 */
export class ExpressionEvaluationError extends Schema.TaggedError<ExpressionEvaluationError>(
  "@usine/expression/ExpressionEvaluationError",
)("ExpressionEvaluationError", {
  source: Source,
  /** A human-readable description, possibly multi-line with a marked excerpt of `source`. The wording isn't stable. */
  message: Schema.NonEmptyString,
}) {}

export const ExpressionError = Schema.Union([ExpressionCheckError, ExpressionEvaluationError]);
export type ExpressionError = typeof ExpressionError.Type;

/**
 * The result of a prompt interpolation; CEL `int` is a `bigint` and `double` is a `number`. A
 * `uint` result passes `checkScalar`, but `evaluateScalar` fails with
 * {@link ExpressionEvaluationError}; wrap it in `string(...)` or `double(...)`.
 */
export const Scalar = Schema.Union([
  Schema.String,
  Schema.Number,
  Schema.BigInt,
  Schema.Boolean,
  Schema.Null,
]);
export type Scalar = typeof Scalar.Type;

export interface ExpressionEngineService {
  /**
   * Returns the string literals compared with the `name` field of values under `memberPath`,
   * following macro bindings and collection transformations. Accepts the syntax that the checks
   * accept, including optional selection (`.?`).
   */
  readonly relatedStringLiterals: (
    source: Source,
    memberPath: ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlyArray<string>, ExpressionCheckError>;
  /** Checks that the expression has type `bool`. */
  readonly checkBoolean: (
    source: Source,
    environment: Environment,
  ) => Effect.Effect<void, ExpressionCheckError>;
  /** Checks that the expression can be a prompt interpolation. */
  readonly checkScalar: (
    source: Source,
    environment: Environment,
  ) => Effect.Effect<void, ExpressionCheckError>;
  /** Checks and evaluates a selection condition against `context`. */
  readonly evaluateBoolean: (
    source: Source,
    environment: Environment,
    context: Schema.JsonObject,
  ) => Effect.Effect<boolean, ExpressionError>;
  /**
   * Checks the condition once and evaluates it against each of `contexts`, returning one
   * `Result` per context in order. Fails with `ExpressionCheckError` if the check fails.
   */
  readonly evaluateBooleanEach: (
    source: Source,
    environment: Environment,
    contexts: ReadonlyArray<Schema.JsonObject>,
  ) => Effect.Effect<
    ReadonlyArray<Result.Result<boolean, ExpressionEvaluationError>>,
    ExpressionCheckError
  >;
  /** Checks and evaluates a prompt interpolation against `context`. */
  readonly evaluateScalar: (
    source: Source,
    environment: Environment,
    context: Schema.JsonObject,
  ) => Effect.Effect<Scalar, ExpressionError>;
}

/** The CEL expression service, provided by `MarcbachmannCelLayer` from `@usine/expression/marcbachmann-cel`. */
export class ExpressionEngine extends Context.Service<ExpressionEngine, ExpressionEngineService>()(
  "@usine/expression/ExpressionEngine",
) {}

export { TypeReference, ObjectField, ObjectType, Variable, Environment } from "./environment.ts";
