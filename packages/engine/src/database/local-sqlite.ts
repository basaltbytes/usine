import { NodeServices } from "@effect/platform-node";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { fileURLToPath } from "node:url";
import * as SQLiteDrizzle from "drizzle-orm/effect-sqlite-node";
import { migrate } from "drizzle-orm/effect-sqlite-node/migrator";
import { sql } from "drizzle-orm";
import { Effect, FileSystem, Layer, Path } from "effect";
import { CursorStore } from "../cursor/store.ts";
import { ItemProjectionReader, ItemProjectionWriter } from "../item-projection/service.ts";
import { LoopControl } from "../loop-control.ts";
import { layerWithDatabase, type RunEngine } from "../engine.ts";
import { EnginePersistenceError, type InstanceDirectory, type RunEngineError } from "../model.ts";
import { RunReader } from "../run-reader.ts";
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

/** Local-first runtime backed by `.usine/runtime.sqlite`. */
export const layer = (
  instanceDirectory: InstanceDirectory,
): Layer.Layer<
  CursorStore | ItemProjectionReader | ItemProjectionWriter | LoopControl | RunEngine | RunReader,
  RunEngineError,
  StepExecutor
> => layerWithDatabase(localSqliteLayer(instanceDirectory)).pipe(Layer.provide(NodeServices.layer));

/** Read-only local projection; it never reconciles workflows or starts Attempts. */
export const observationLayer = (
  instanceDirectory: InstanceDirectory,
): Layer.Layer<ItemProjectionReader | LoopControl | RunReader, RunEngineError> => {
  const database = localSqliteLayer(instanceDirectory);
  return Layer.mergeAll(ItemProjectionReader.layer, LoopControl.layer, RunReader.layer).pipe(
    Layer.provide(database),
  );
};
