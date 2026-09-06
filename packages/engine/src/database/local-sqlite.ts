import { NodeServices } from "@effect/platform-node";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { fileURLToPath } from "node:url";
import * as SQLiteDrizzle from "drizzle-orm/effect-sqlite-node";
import { migrate } from "drizzle-orm/effect-sqlite-node/migrator";
import { sql } from "drizzle-orm";
import { Effect, FileSystem, Layer, Option, Path, PlatformError, Schema } from "effect";
import type { SqlError } from "effect/unstable/sql/SqlError";
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

const runtimeStorePath = (path: Path.Path, instanceDirectory: InstanceDirectory) =>
  path.join(instanceDirectory, ".usine", "runtime.sqlite");

const sqliteClientLayer = (instanceDirectory: InstanceDirectory) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* fileSystem.makeDirectory(path.join(instanceDirectory, ".usine"), { recursive: true });
      return SqliteClient.layer({ filename: runtimeStorePath(path, instanceDirectory) });
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

/** Confirms the runtime store is a readable regular file; the platform reason names what is wrong otherwise. */
const readableRuntimeStore = Effect.fn("LocalSqlite.readableRuntimeStore")(function* (
  filename: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  yield* fileSystem.access(filename, { readable: true });
  const info = yield* fileSystem.stat(filename);
  if (info.type !== "File")
    return yield* PlatformError.systemError({
      _tag: "BadResource",
      module: "FileSystem",
      method: "stat",
      pathOrDescriptor: filename,
      description: `Expected a regular SQLite file, found ${info.type}`,
    });
});

const readOnlySqliteLayer = (filename: string) =>
  SqliteClient.layer({ filename, readonly: true, disableWAL: true });

const existingSqliteLayer = (instanceDirectory: InstanceDirectory) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const filename = runtimeStorePath(yield* Path.Path, instanceDirectory);
      yield* readableRuntimeStore(filename);
      return readOnlySqliteLayer(filename);
    }).pipe(
      Effect.mapError((cause) => startupError("open existing local database", cause)),
      Effect.provide(NodeServices.layer),
    ),
  );

/** Opens an existing `.usine/runtime.sqlite` in SQLite read-only mode, without initializing or migrating the database. */
export const runReaderLayer = (
  instanceDirectory: InstanceDirectory,
): Layer.Layer<RunReader, EnginePersistenceError> => {
  const sqlClient = existingSqliteLayer(instanceDirectory);
  const database = Layer.effect(RunDatabase, SQLiteDrizzle.makeWithDefaults()).pipe(
    Layer.provide(sqlClient),
  );
  return RunReader.layer.pipe(Layer.provide(database));
};

/** The online backup stopped before publishing a complete file.
 * `operation` names the phase that failed, `path` the file or directory it acted on
 * (the source store for `open` and `copy`, the destination for `stage` and `publish`),
 * and `reason` the platform reason or SQLite's own message.
 */
export class RuntimeStoreBackupError extends Schema.TaggedError<RuntimeStoreBackupError>(
  "@usine/engine/RuntimeStoreBackupError",
)("RuntimeStoreBackupError", {
  operation: Schema.Literals(["open", "stage", "copy", "publish"]),
  path: Schema.String,
  reason: Schema.String,
  cause: Schema.Defect(),
}) {}

const vendorMessage = Schema.decodeUnknownOption(Schema.Struct({ message: Schema.NonEmptyString }));

/** Names a failure from safe fields: the platform reason, or SQLite's message behind a generic SqlError. */
const failureReason = (cause: PlatformError.PlatformError | SqlError): string =>
  cause._tag === "PlatformError"
    ? (cause.reason.description ?? cause.reason._tag)
    : Option.match(vendorMessage(cause.reason.cause), {
        onNone: () => cause.reason._tag,
        onSome: ({ message }) => message,
      });

const backupFailure =
  (operation: RuntimeStoreBackupError["operation"], path: string) =>
  <A, R>(
    effect: Effect.Effect<A, PlatformError.PlatformError | SqlError, R>,
  ): Effect.Effect<A, RuntimeStoreBackupError, R> =>
    Effect.mapError(
      effect,
      (cause) =>
        new RuntimeStoreBackupError({ operation, path, reason: failureReason(cause), cause }),
    );

/** Copies the existing runtime database through SQLite's online backup API.
 * The destination's parent must exist. Publication is atomic and refuses an existing
 * destination; the source is opened read-only without migrations or workflow recovery.
 */
export const backup = Effect.fn("LocalSqlite.backup")(
  function* (instanceDirectory: InstanceDirectory, destination: string) {
    yield* Effect.annotateCurrentSpan({ instanceDirectory, destination });
    yield* Effect.logInfo("Runtime store backup started", { instanceDirectory, destination });
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const source = runtimeStorePath(path, instanceDirectory);
    yield* readableRuntimeStore(source).pipe(backupFailure("open", source));
    const { totalPages } = yield* Effect.scoped(
      Effect.gen(function* () {
        const directory = path.dirname(destination);
        const temporary = yield* fileSystem
          .makeTempDirectoryScoped({ directory, prefix: ".usine-backup-" })
          .pipe(backupFailure("stage", directory));
        const staged = path.join(temporary, "runtime.sqlite");
        yield* fileSystem
          .writeFile(staged, new Uint8Array(), { mode: 0o600 })
          .pipe(backupFailure("stage", directory));
        const metadata = yield* Effect.flatMap(SqliteClient.SqliteClient, (client) =>
          // The native backup Promise cannot be canceled. Keep its connection and
          // staging directory alive until it settles, including on interruption.
          client.backup(staged).pipe(backupFailure("copy", source), Effect.uninterruptible),
        ).pipe(Effect.provide(readOnlySqliteLayer(source)));
        // A hard link publishes only the completed file and refuses existing paths,
        // including the source database and aliases to it.
        yield* fileSystem.link(staged, destination).pipe(backupFailure("publish", destination));
        return metadata;
      }),
    );
    yield* Effect.annotateCurrentSpan({ totalPages });
    yield* Effect.logInfo("Runtime store backup completed", {
      instanceDirectory,
      destination,
      totalPages,
    });
  },
  Effect.tapError((error) =>
    Effect.logWarning("Runtime store backup failed", {
      errorTag: error._tag,
      operation: error.operation,
      path: error.path,
      reason: error.reason,
    }),
  ),
  Effect.provide(NodeServices.layer),
);
