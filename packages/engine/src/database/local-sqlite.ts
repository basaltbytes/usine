import { type SqlError, SqlClient } from "effect/sql";
import { AttentionAcknowledgements } from "../attention/attention.ts";
import { NodeServices } from "@effect/platform-node";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { fileURLToPath } from "node:url";
import * as SQLiteDrizzle from "drizzle-orm/effect-sqlite-node";
import { migrate } from "drizzle-orm/effect-sqlite-node/migrator";
import {
  type Brand,
  Context,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  PlatformError,
  Schema,
  Tracer,
} from "effect";

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
import { foreignKeys, migrationNameColumn } from "./dialect.ts";
import { ReadSnapshot, RunDatabase } from "./database.ts";
import { withReadWorker } from "./sqlite-reader/reader.ts";
import { SqliteReader, type SqliteReaderState } from "./sqlite-reader/status.ts";

export { SqliteReader, SqliteReaderState } from "./sqlite-reader/status.ts";

const migrationsFolder = fileURLToPath(new URL("../../drizzle", import.meta.url));

const startupError = (operation: string, cause: unknown) =>
  EnginePersistenceError.make({ operation, cause });

const runtimeStorePath = (path: Path.Path, instanceDirectory: InstanceDirectory) =>
  path.join(instanceDirectory, ".usine", "runtime.sqlite");

const withExternalParentSpan = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.flatMap(Effect.serviceOption(Tracer.ParentSpan), (parent) =>
    Option.match(parent, {
      onNone: () => effect,
      onSome: ({ spanId, traceId, sampled }) =>
        Effect.provideService(
          effect,
          Tracer.ParentSpan,
          Tracer.externalSpan({ spanId, traceId, sampled }),
        ),
    }),
  );

/** Returns `SqliteClient.layer`, failing with `onError` when the database can't be opened. */
const openSqliteLayer = <E>(
  config: SqliteClient.SqliteClientConfig,
  onError: (cause: SqlError.SqlError) => E,
) =>
  Layer.effectContext(
    Effect.gen(function* () {
      const context = yield* Layer.build(SqliteClient.layer(config));
      const client = Context.get(context, SqliteClient.SqliteClient);
      // Wrap the single connection before sharing it, including transaction and reserved uses.
      yield* Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* client.reserve;
          const { execute, executeRaw, executeValues } = connection;
          Object.assign(connection, {
            execute: (...args: Parameters<typeof execute>) =>
              withExternalParentSpan(execute(...args)),
            executeRaw: (...args: Parameters<typeof executeRaw>) =>
              withExternalParentSpan(executeRaw(...args)),
            executeValues: (...args: Parameters<typeof executeValues>) =>
              withExternalParentSpan(executeValues(...args)),
          });
        }),
      );
      yield* Effect.logDebug("SQLite statement cache span isolation installed", {
        filename: config.filename,
      });
      if (config.readonly === true)
        return Context.add(context, SqliteReader, {
          state: Effect.succeed<SqliteReaderState>("fallback"),
        });
      const routed = yield* withReadWorker(client);
      return context.pipe(
        Context.add(SqlClient.SqlClient, routed.client),
        Context.add(SqliteClient.SqliteClient, routed.client),
        Context.add(ReadSnapshot, { run: (_database, effect) => routed.readSnapshot(effect) }),
        Context.add(SqliteReader, { state: routed.state }),
      );
    }).pipe(Effect.mapError(onError)),
  );

const sqliteClientLayer = (instanceDirectory: InstanceDirectory) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* fileSystem.makeDirectory(path.join(instanceDirectory, ".usine"), { recursive: true });
      return openSqliteLayer({ filename: runtimeStorePath(path, instanceDirectory) }, (cause) =>
        startupError("open local database", cause),
      );
    }).pipe(Effect.mapError((cause) => startupError("prepare local database directory", cause))),
  ).pipe(Layer.provide(NodeServices.layer));

/**
 * Returns a Node SQLite layer at `<instanceDirectory>/.usine/runtime.sqlite`, creating the
 * directory and applying engine migrations. Provides `RunDatabase` and its matching `SqlClient`;
 * reuse the layer to share the writer and read worker (ADR 0020).
 */
export const localSqliteLayer = (instanceDirectory: InstanceDirectory) => {
  const sqlClient = sqliteClientLayer(instanceDirectory);
  const database = Layer.effect(
    RunDatabase,
    Effect.gen(function* () {
      const drizzle = yield* SQLiteDrizzle.makeWithDefaults();
      const client = yield* SqlClient.SqlClient;
      const columns = yield* migrationNameColumn(client);
      if (columns.length > 0) {
        const renamed =
          yield* client`UPDATE usine_migrations SET name = '20261029101340_member_approval_source' WHERE name = '20261029101340_bored_paladin' RETURNING id`;
        if (renamed.length > 0)
          yield* Effect.logInfo("Approval migration ledger name updated", { instanceDirectory });
      }
      // SQLite ignores `foreign_keys` changes inside a transaction, and Drizzle rebuilds
      // referenced tables while migrating, so enforcement is turned off before migrating and
      // back on even if a migration fails.
      yield* drizzle.run(foreignKeys.disable).execute();
      yield* migrate(drizzle, {
        migrationsFolder,
        migrationsTable: "usine_migrations",
      }).pipe(Effect.ensuring(drizzle.run(foreignKeys.enable).execute().pipe(Effect.orDie)));
      return drizzle;
    }).pipe(Effect.mapError((cause) => startupError("initialize local database", cause))),
  );
  return database.pipe(Layer.provideMerge(sqlClient));
};

/**
 * Returns the local engine runtime, including startup recovery and periodic reconciliation.
 *
 * @param instanceDirectory - The instance folder containing `.usine/runtime.sqlite`.
 * @param database - A shared, initialized database layer; omit to open and migrate the local file.
 */
export const layer = (
  instanceDirectory: InstanceDirectory,
  database: Layer.Layer<RunDatabase, EnginePersistenceError> = localSqliteLayer(instanceDirectory),
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
> => layerWithDatabase(database).pipe(Layer.provide(NodeServices.layer));

/**
 * Returns the observation services without recovering runs or starting attempts.
 *
 * @param instanceDirectory - The instance folder containing `.usine/runtime.sqlite`.
 * @param database - A shared, initialized database layer; omit to open and migrate the local file.
 */
export const observationLayer = (
  instanceDirectory: InstanceDirectory,
  database: Layer.Layer<RunDatabase, EnginePersistenceError> = localSqliteLayer(instanceDirectory),
): Layer.Layer<
  | AttentionAcknowledgements
  | CycleBudgets
  | ItemProjectionReader
  | LoopControl
  | RepositoryLabelProjectionReader
  | RunReader
  | UnconfirmedStops,
  RunEngineError
> =>
  Layer.mergeAll(
    AttentionAcknowledgements.layer,
    CycleBudgets.layer,
    ItemProjectionReader.layer,
    LoopControl.layer,
    RepositoryLabelProjectionReader.layer,
    RunReader.layer,
  ).pipe(Layer.provide(database), Layer.merge(UnconfirmedStops.empty));

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

const readOnlySqliteLayer = <E>(filename: string, onError: (cause: SqlError.SqlError) => E) =>
  openSqliteLayer({ filename, readonly: true, disableWAL: true }, onError);

const existingSqliteLayer = (instanceDirectory: InstanceDirectory) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const filename = runtimeStorePath(path, instanceDirectory);
      yield* readableRuntimeStore(filename);
      return readOnlySqliteLayer(filename, (cause) =>
        startupError("open existing local database", cause),
      );
    }).pipe(Effect.mapError((cause) => startupError("open existing local database", cause))),
  ).pipe(Layer.provide(NodeServices.layer));

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
export class RuntimeStoreBackupError extends Schema.TaggedError<
  RuntimeStoreBackupError,
  Brand.Brand<"@usine/engine/database/local-sqlite/RuntimeStoreBackupError">
>("@usine/engine/RuntimeStoreBackupError")("RuntimeStoreBackupError", {
  /**
   * The failed phase: `open` checks or opens the source, `stage` prepares a temporary file, `copy`
   * runs SQLite backup, and `publish` creates the destination hard link.
   */
  operation: Schema.Literals(["open", "stage", "copy", "publish"]),
  /** The runtime SQLite file being copied. */
  source: Schema.String,
  /** The requested backup path; publishing fails if this path already exists. */
  destination: Schema.String,
  /** The underlying filesystem or SQLite diagnostic, for operator display. */
  reason: Schema.String,
  /** The original filesystem or SQLite error, retained for diagnostics. */
  cause: Schema.Defect(),
}) {}

const vendorMessage = Schema.decodeUnknownOption(Schema.Struct({ message: Schema.NonEmptyString }));
const errnoCode = Schema.decodeUnknownOption(Schema.Struct({ code: Schema.NonEmptyString }));

const failureReason = (cause: PlatformError.PlatformError | SqlError.SqlError): string => {
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
      (cause: PlatformError.PlatformError | SqlError.SqlError) =>
        RuntimeStoreBackupError.make({
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
        const backupContext = yield* Layer.build(readOnlySqliteLayer(source, failure("open")));
        const client = Context.get(backupContext, SqliteClient.SqliteClient);
        // Node's backup can't be canceled; wait before closing the database or deleting staging.
        const metadata = yield* client.backup(staged).pipe(failed("copy"), Effect.uninterruptible);
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
);
