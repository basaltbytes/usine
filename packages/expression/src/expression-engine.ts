import { Context, type Effect, type Schema } from "effect";
import type {
  Environment,
  ExpressionCheckError,
  ExpressionError,
  Scalar,
  Source,
} from "./model.ts";

/** CEL checking, evaluation, and literal scanning, independent of the CEL backend. */
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
  readonly checkBoolean: (
    source: Source,
    environment: Environment,
  ) => Effect.Effect<void, ExpressionCheckError>;
  readonly checkScalar: (
    source: Source,
    environment: Environment,
  ) => Effect.Effect<void, ExpressionCheckError>;
  readonly evaluateBoolean: (
    source: Source,
    environment: Environment,
    context: Schema.JsonObject,
  ) => Effect.Effect<boolean, ExpressionError>;
  readonly evaluateScalar: (
    source: Source,
    environment: Environment,
    context: Schema.JsonObject,
  ) => Effect.Effect<Scalar, ExpressionError>;
}

export class ExpressionEngine extends Context.Service<ExpressionEngine, ExpressionEngineService>()(
  "@usine/expression/ExpressionEngine",
) {}
