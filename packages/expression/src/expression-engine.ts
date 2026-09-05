import { Context, type Effect, type Schema } from "effect";
import type {
  Environment,
  ExpressionCheckError,
  ExpressionError,
  Scalar,
  Source,
} from "./model.ts";

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
