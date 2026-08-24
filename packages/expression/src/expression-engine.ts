import { Context, type Effect, type Schema } from "effect";
import type { CheckError, Environment, EvaluationError, Scalar, Source } from "./model.ts";

/** Backend-neutral CEL operations used by config parsing and prompt rendering. */
export interface ExpressionEngineService {
  readonly checkBoolean: (
    source: Source,
    environment: Environment,
  ) => Effect.Effect<void, CheckError>;
  readonly checkScalar: (
    source: Source,
    environment: Environment,
  ) => Effect.Effect<void, CheckError>;
  readonly evaluateBoolean: (
    source: Source,
    environment: Environment,
    context: Schema.JsonObject,
  ) => Effect.Effect<boolean, CheckError | EvaluationError>;
  readonly evaluateScalar: (
    source: Source,
    environment: Environment,
    context: Schema.JsonObject,
  ) => Effect.Effect<Scalar, CheckError | EvaluationError>;
}

export class ExpressionEngine extends Context.Service<ExpressionEngine, ExpressionEngineService>()(
  "@usine/expression/ExpressionEngine",
) {}
