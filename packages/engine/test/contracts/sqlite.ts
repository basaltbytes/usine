import { NodeServices } from "@effect/platform-node";
import { InstanceDirectory } from "@usine/core/instance";
import { Effect, FileSystem, Layer } from "effect";
import { SqlClient } from "effect/sql";

import { sqliteTempDirectory } from "../../../../tooling/test/sqlite.mts";
import { AttentionAcknowledgements } from "../../src/attention/attention.ts";
import { BoardMoves } from "../../src/board-moves/board-moves.ts";
import { CursorStore } from "../../src/cursor/cursor.ts";
import { CycleBudgets } from "../../src/cycle-budget/cycle-budget.ts";
import { localSqliteLayer } from "../../src/database/local-sqlite.ts";
import { EnginePersistenceError } from "../../src/engine/error.ts";
import {
  ItemProjectionReader,
  ItemProjectionWriter,
} from "../../src/item-projection/item-projection.ts";
import { LoopControl } from "../../src/loop-control/loop-control.ts";
import {
  RepositoryLabelProjectionReader,
  RepositoryLabelProjectionWriter,
} from "../../src/repository-label-projection/repository-label-projection.ts";
import { RunReader } from "../../src/run-reader/run-reader.ts";
import { RunStore } from "../../src/store/store.ts";
import { WriteFailures, type PersistenceAdapter } from "./adapter.ts";

const persistence = <A, E>(effect: Effect.Effect<A, E>) =>
  effect.pipe(
    Effect.mapError((cause) =>
      EnginePersistenceError.make({ operation: "inject test write failure", cause }),
    ),
  );
const failures = Layer.effect(
  WriteFailures,
  Effect.gen(function* () {
    const client = yield* SqlClient.SqlClient;
    return {
      rejectAttemptInsert:
        client`CREATE TRIGGER reject_attempt BEFORE INSERT ON usine_attempts BEGIN SELECT RAISE(ABORT, 'attempt insertion unavailable'); END`.pipe(
          persistence,
          Effect.as(client`DROP TRIGGER reject_attempt`.pipe(persistence, Effect.asVoid)),
        ),
      rejectRunUpdate:
        client`CREATE TRIGGER reject_closing BEFORE UPDATE ON usine_runs BEGIN SELECT RAISE(ABORT, 'run update unavailable'); END`.pipe(
          persistence,
          Effect.as(client`DROP TRIGGER reject_closing`.pipe(persistence, Effect.asVoid)),
        ),
    };
  }),
);

export const sqliteAdapter: PersistenceAdapter = {
  name: "sqlite",
  fixture: Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = InstanceDirectory.make(
      yield* fs.makeTempDirectoryScoped({
        directory: sqliteTempDirectory(),
        prefix: "usine-contract-",
      }),
    );
    return {
      open: Layer.fresh(
        Layer.mergeAll(
          AttentionAcknowledgements.layer,
          BoardMoves.layer,
          CursorStore.layer,
          CycleBudgets.layer,
          ItemProjectionReader.layer,
          ItemProjectionWriter.layer,
          LoopControl.layer,
          RepositoryLabelProjectionReader.layer,
          RepositoryLabelProjectionWriter.layer,
          RunReader.layer,
          RunStore.layer,
          failures,
        ).pipe(Layer.provide(localSqliteLayer(directory)), Layer.provide(NodeServices.layer)),
      ),
    };
  }).pipe(
    Effect.provide(NodeServices.layer),
    Effect.mapError((cause) =>
      EnginePersistenceError.make({ operation: "prepare persistence contract fixture", cause }),
    ),
  ),
};
