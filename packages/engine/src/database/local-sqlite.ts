import { NodeServices } from "@effect/platform-node";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { fileURLToPath } from "node:url";
import * as SQLiteDrizzle from "drizzle-orm/effect-sqlite-node";
import { migrate } from "drizzle-orm/effect-sqlite-node/migrator";
import { sql } from "drizzle-orm";
import { Effect, FileSystem, Layer, Path } from "effect";
import { CursorStore } from "../cursor/cursor.ts";
import { ItemProjectionReader, ItemProjectionWriter } from "../item-projection/item-projection.ts";
import {
  RepositoryLabelProjectionReader,
  RepositoryLabelProjectionWriter,
} from "../repository-label-projection/repository-label-projection.ts";
import { LoopControl } from "../loop-control/loop-control.ts";
import { CycleBudgets } from "../cycle-budget/cycle-budget.ts";
import { layerWithDatabase, type RunEngine } from "../engine/engine.ts";
import type { InstanceDirectory } from "@usine/core/instance";
import { EnginePersistenceError, type RunEngineError } from "../engine/error.ts";
import { RunReader } from "../run-reader/run-reader.ts";
import type { StepExecutor } from "../step-executor.ts";
import { RunDatabase } from "./database.ts";

const migrationsFolder = fileURLToPath(new URL("../../drizzle", import.meta.url));

const startupError = (operation: string, cause: unknown) =>
  new EnginePersistenceError({ operation, cause });

const sqliteClientLayer = (instanceDirectory: InstanceDirectory) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const runtimeDirectory = path.join(instanceDirectory, ".usine");
      yield* fileSystem.makeDirectory(runtimeDirectory, { recursive: true });
      return SqliteClient.layer({ filename: path.join(runtimeDirectory, "runtime.sqlite") });
    }).pipe(
      Effect.mapError((cause) => startupError("prepare local database directory", cause)),
      Effect.provide(NodeServices.layer),
    ),
  );

export const localSqliteLayer = (instanceDirectory: InstanceDirectory) => {
  const sqlClient = sqliteClientLayer(instanceDirectory);
  const database = Layer.effect(
    RunDatabase,
    Effect.gen(function* () {
      const drizzle = yield* SQLiteDrizzle.makeWithDefaults();
      yield* drizzle.run(sql`PRAGMA foreign_keys = ON`).execute();
      yield* migrate(drizzle, {
        migrationsFolder,
        migrationsTable: "usine_migrations",
      });
      return drizzle;
    }).pipe(Effect.mapError((cause) => startupError("initialize local database", cause))),
  );
  return database.pipe(Layer.provideMerge(sqlClient));
};

/** The local runtime on `.usine/runtime.sqlite`. */
export const layer = (
  instanceDirectory: InstanceDirectory,
): Layer.Layer<
  | CursorStore
  | CycleBudgets
  | ItemProjectionReader
  | ItemProjectionWriter
  | LoopControl
  | RepositoryLabelProjectionReader
  | RepositoryLabelProjectionWriter
  | RunEngine
  | RunReader,
  RunEngineError,
  StepExecutor
> => layerWithDatabase(localSqliteLayer(instanceDirectory)).pipe(Layer.provide(NodeServices.layer));

/** Observation services initialize the local database but never reconcile workflows or start Attempts. */
export const observationLayer = (
  instanceDirectory: InstanceDirectory,
): Layer.Layer<
  CycleBudgets | ItemProjectionReader | LoopControl | RepositoryLabelProjectionReader | RunReader,
  RunEngineError
> => {
  const database = localSqliteLayer(instanceDirectory);
  return Layer.mergeAll(
    CycleBudgets.layer,
    ItemProjectionReader.layer,
    LoopControl.layer,
    RepositoryLabelProjectionReader.layer,
    RunReader.layer,
  ).pipe(Layer.provide(database));
};

/** Opens an existing `.usine/runtime.sqlite` in SQLite read-only mode, without initializing or migrating the database. */
export const runReaderLayer = (
  instanceDirectory: InstanceDirectory,
): Layer.Layer<RunReader, EnginePersistenceError> => {
  const sqlClient = Layer.unwrap(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const filename = path.join(instanceDirectory, ".usine", "runtime.sqlite");
      const info = yield* fileSystem.access(filename, { readable: true }).pipe(
        Effect.andThen(fileSystem.stat(filename)),
        Effect.mapError((cause) => startupError("open existing local database", cause)),
      );
      if (info.type !== "File")
        return yield* startupError("open existing local database", {
          path: filename,
          reason: "Expected a regular SQLite file",
          type: info.type,
        });
      return SqliteClient.layer({ filename, readonly: true, disableWAL: true });
    }).pipe(Effect.provide(NodeServices.layer)),
  );
  const database = Layer.effect(RunDatabase, SQLiteDrizzle.makeWithDefaults()).pipe(
    Layer.provide(sqlClient),
  );
  return RunReader.layer.pipe(Layer.provide(database));
};
