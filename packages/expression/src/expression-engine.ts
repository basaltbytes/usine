import { Context, type Effect, type Schema } from "effect";
import type {
  Environment,
  ExpressionCheckError,
  ExpressionError,
  Scalar,
  Source,
} from "./model.ts";

/** Backend-neutral CEL operations used by config parsing and prompt rendering. */
export interface ExpressionEngineService {
  /**
   * String literals compared against the `name` leaf of values whose lineage
   * starts at `memberPath` (through macro bindings and collection
   * transformations). This keeps config diagnostics independent of the CEL
   * backend's AST.
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
