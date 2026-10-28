import { AttentionAcknowledgements } from "../attention/attention.ts";
import { NodeServices } from "@effect/platform-node";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { fileURLToPath } from "node:url";
import * as SQLiteDrizzle from "drizzle-orm/effect-sqlite-node";
import { migrate } from "drizzle-orm/effect-sqlite-node/migrator";
import { sql } from "drizzle-orm";
import { Effect, FileSystem, Layer, Option, Path, PlatformError, Schema } from "effect";
import type { SqlError } from "effect/sql/SqlError";
import { CursorStore } from "../cursor/cursor.ts";
import { ItemProjectionReader, ItemProjectionWriter } from "../item-projection/item-projection.ts";
import {
  RepositoryLabelProjectionReader,
  RepositoryLabelProjectionWriter,
} from "../repository-label-projection/repository-label-projection.ts";
import { LoopControl } from "../loop-control/loop-control.ts";
import { BoardMoves } from "../board-moves/board-moves.ts";
import { CycleBudgets } from "../cycle-budget/cycle-budget.ts";
import { layerWithDatabase, type RunEngine } from "../engine/engine.ts";
import { UnconfirmedStops } from "../engine/unconfirmed-stops.ts";
import type { InstanceDirectory } from "@usine/core/instance";
import { EnginePersistenceError, type RunEngineError } from "../engine/error.ts";
import { RunReader } from "../run-reader/run-reader.ts";
import type { StepExecutor } from "../step-executor.ts";
import type { TriggerCondition } from "../trigger-condition.ts";
import { RunDatabase } from "./database.ts";

const migrationsFolder = fileURLToPath(new URL("../../drizzle", import.meta.url));

const startupError = (operation: string, cause: unknown) =>
  new EnginePersistenceError({ operation, cause });

const runtimeStorePath = (path: Path.Path, instanceDirectory: InstanceDirectory) =>
  path.join(instanceDirectory, ".usine", "runtime.sqlite");

/** Returns `SqliteClient.layer`, failing with `onError` when the database can't be opened. */
const openSqliteLayer = <E>(
  config: SqliteClient.SqliteClientConfig,
  onError: (cause: SqlError) => E,
) => Layer.effectContext(Layer.build(SqliteClient.layer(config)).pipe(Effect.mapError(onError)));

const sqliteClientLayer = (instanceDirectory: InstanceDirectory) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* fileSystem.makeDirectory(path.join(instanceDirectory, ".usine"), { recursive: true });
      return openSqliteLayer({ filename: runtimeStorePath(path, instanceDirectory) }, (cause) =>
        startupError("open local database", cause),
      );
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
      // SQLite ignores `foreign_keys` changes inside a transaction, and Drizzle rebuilds
      // referenced tables while migrating, so enforcement is turned off before migrating and
      // back on even if a migration fails.
      yield* drizzle.run(sql`PRAGMA foreign_keys = OFF`).execute();
      yield* migrate(drizzle, {
        migrationsFolder,
        migrationsTable: "usine_migrations",
      }).pipe(
        Effect.ensuring(
          drizzle
            .run(sql`PRAGMA foreign_keys = ON`)
            .execute()
            .pipe(Effect.orDie),
        ),
      );
      return drizzle;
    }).pipe(Effect.mapError((cause) => startupError("initialize local database", cause))),
  );
  return database.pipe(Layer.provideMerge(sqlClient));
};

/** Returns the local runtime layer on `.usine/runtime.sqlite`. */
export const layer = (
  instanceDirectory: InstanceDirectory,
): Layer.Layer<
  | AttentionAcknowledgements
  | BoardMoves
  | CursorStore
  | CycleBudgets
  | ItemProjectionReader
  | ItemProjectionWriter
  | LoopControl
  | RepositoryLabelProjectionReader
  | RepositoryLabelProjectionWriter
  | RunEngine
  | RunReader
  | UnconfirmedStops,
  RunEngineError,
  StepExecutor | TriggerCondition
> => layerWithDatabase(localSqliteLayer(instanceDirectory)).pipe(Layer.provide(NodeServices.layer));

/** Returns the observation layer, which initializes the local database but never recovers Runs or starts Attempts. */
export const observationLayer = (
  instanceDirectory: InstanceDirectory,
): Layer.Layer<
  | AttentionAcknowledgements
  | CycleBudgets
  | ItemProjectionReader
  | LoopControl
  | RepositoryLabelProjectionReader
  | RunReader
  | UnconfirmedStops,
  RunEngineError
> => {
  const database = localSqliteLayer(instanceDirectory);
  return Layer.mergeAll(
    AttentionAcknowledgements.layer,
    CycleBudgets.layer,
    ItemProjectionReader.layer,
    LoopControl.layer,
    RepositoryLabelProjectionReader.layer,
    RunReader.layer,
  ).pipe(Layer.provide(database), Layer.merge(UnconfirmedStops.empty));
};

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

const readOnlySqliteLayer = <E>(filename: string, onError: (cause: SqlError) => E) =>
  openSqliteLayer({ filename, readonly: true, disableWAL: true }, onError);

const existingSqliteLayer = (instanceDirectory: InstanceDirectory) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const filename = runtimeStorePath(yield* Path.Path, instanceDirectory);
      yield* readableRuntimeStore(filename);
      return readOnlySqliteLayer(filename, (cause) =>
        startupError("open existing local database", cause),
      );
    }).pipe(
      Effect.mapError((cause) => startupError("open existing local database", cause)),
      Effect.provide(NodeServices.layer),
    ),
  );

/** Returns a layer that opens an existing `.usine/runtime.sqlite` read-only, without initializing or migrating it. */
export const runReaderLayer = (
  instanceDirectory: InstanceDirectory,
): Layer.Layer<RunReader, EnginePersistenceError> => {
  const sqlClient = existingSqliteLayer(instanceDirectory);
  const database = Layer.effect(RunDatabase, SQLiteDrizzle.makeWithDefaults()).pipe(
    Layer.provide(sqlClient),
  );
  return RunReader.layer.pipe(Layer.provide(database));
};

/** An error from a backup, with both paths because a copy error can come from either file. */
export class RuntimeStoreBackupError extends Schema.TaggedError<RuntimeStoreBackupError>(
  "@usine/engine/RuntimeStoreBackupError",
)("RuntimeStoreBackupError", {
  operation: Schema.Literals(["open", "stage", "copy", "publish"]),
  source: Schema.String,
  destination: Schema.String,
  reason: Schema.String,
  cause: Schema.Defect(),
}) {}

const vendorMessage = Schema.decodeUnknownOption(Schema.Struct({ message: Schema.NonEmptyString }));
const errnoCode = Schema.decodeUnknownOption(Schema.Struct({ code: Schema.NonEmptyString }));

const failureReason = (cause: PlatformError.PlatformError | SqlError): string => {
  if (cause._tag === "SqlError")
    return Option.match(vendorMessage(cause.reason.cause), {
      onNone: () => cause.reason._tag,
      onSome: ({ message }) => message,
    });
  if (cause.reason.description !== undefined) return cause.reason.description;
  if (cause.reason._tag !== "Unknown") return cause.reason._tag;
  return Option.match(errnoCode(cause.reason.cause), {
    onNone: () => cause.reason._tag,
    onSome: ({ code }) => code,
  });
};

/**
 * Copies `.usine/runtime.sqlite` to `destination` while the orchestrator runs, without
 * overwriting an existing file. The destination directory must exist and support hard links.
 */
export const backup = Effect.fn("LocalSqlite.backup")(
  function* (instanceDirectory: InstanceDirectory, destination: string) {
    yield* Effect.annotateCurrentSpan({ instanceDirectory, destination });
    yield* Effect.logInfo("Runtime store backup started", { instanceDirectory, destination });
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const source = runtimeStorePath(path, instanceDirectory);
    const failure =
      (operation: RuntimeStoreBackupError["operation"]) =>
      (cause: PlatformError.PlatformError | SqlError) =>
        new RuntimeStoreBackupError({
          operation,
          source,
          destination,
          reason: failureReason(cause),
          cause,
        });
    const failed = (operation: RuntimeStoreBackupError["operation"]) =>
      Effect.mapError(failure(operation));
    yield* readableRuntimeStore(source).pipe(failed("open"));
    const { totalPages } = yield* Effect.scoped(
      Effect.gen(function* () {
        const directory = path.dirname(destination);
        const temporary = yield* fileSystem
          .makeTempDirectoryScoped({ directory, prefix: ".usine-backup-" })
          .pipe(failed("stage"));
        const staged = path.join(temporary, "runtime.sqlite");
        yield* fileSystem
          .writeFile(staged, new Uint8Array(), { mode: 0o600 })
          .pipe(failed("stage"));
        const metadata = yield* Effect.flatMap(SqliteClient.SqliteClient, (client) =>
          // Node's backup can't be canceled; wait before closing the database or deleting staging.
          client.backup(staged).pipe(failed("copy"), Effect.uninterruptible),
        ).pipe(Effect.provide(readOnlySqliteLayer(source, failure("open"))));
        // A hard link atomically creates the destination without overwriting it.
        yield* fileSystem.link(staged, destination).pipe(failed("publish"));
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
      source: error.source,
      destination: error.destination,
      reason: error.reason,
    }),
  ),
  Effect.provide(NodeServices.layer),
);
