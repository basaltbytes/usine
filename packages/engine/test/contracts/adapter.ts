import { Context, Effect, type Layer, type Scope } from "effect";

import type { AttentionAcknowledgements } from "../../src/attention/attention.ts";
import type { BoardMoves } from "../../src/board-moves/board-moves.ts";
import type { CursorStore } from "../../src/cursor/cursor.ts";
import type { CycleBudgets } from "../../src/cycle-budget/cycle-budget.ts";
import type { EnginePersistenceError } from "../../src/engine/error.ts";
import type {
  ItemProjectionReader,
  ItemProjectionWriter,
} from "../../src/item-projection/item-projection.ts";
import type { LoopControl } from "../../src/loop-control/loop-control.ts";
import type {
  RepositoryLabelProjectionReader,
  RepositoryLabelProjectionWriter,
} from "../../src/repository-label-projection/repository-label-projection.ts";
import type { RunReader } from "../../src/run-reader/run-reader.ts";
import type { RunStore } from "../../src/store/store.ts";

export class WriteFailures extends Context.Service<
  WriteFailures,
  {
    readonly rejectAttemptInsert: Effect.Effect<
      Effect.Effect<void, EnginePersistenceError>,
      EnginePersistenceError
    >;
    readonly rejectRunUpdate: Effect.Effect<
      Effect.Effect<void, EnginePersistenceError>,
      EnginePersistenceError
    >;
  }
>()("test/WriteFailures") {}

export type PersistencePorts =
  | AttentionAcknowledgements
  | BoardMoves
  | CursorStore
  | CycleBudgets
  | ItemProjectionReader
  | ItemProjectionWriter
  | LoopControl
  | RepositoryLabelProjectionReader
  | RepositoryLabelProjectionWriter
  | RunReader
  | RunStore
  | WriteFailures;

export interface PersistenceFixture {
  /** Opens the same store in a fresh scope, preserving committed records. */
  readonly open: Layer.Layer<PersistencePorts, EnginePersistenceError>;
}

export interface PersistenceAdapter {
  readonly name: string;
  /** Allocates isolated storage and removes it after the test. */
  readonly fixture: Effect.Effect<PersistenceFixture, EnginePersistenceError, Scope.Scope>;
}

export const withPersistence = <A, E, R>(
  adapter: PersistenceAdapter,
  work: Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const fixture = yield* adapter.fixture;
    return yield* work.pipe(Effect.provide(fixture.open));
  }).pipe(Effect.scoped);
