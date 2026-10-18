import { backup as backupDatabase, DatabaseSync } from "node:sqlite";
import { NodeServices } from "@effect/platform-node";
import type { InstanceDirectory } from "@usine/core/instance";
import { Effect, FileSystem, Option, Path, type PlatformError, Schema } from "effect";
import { durableStoragePath } from "./storage-path.ts";

/** A failed durable storage backup, with both paths because a copy error can come from either file. */
export class DurableStorageBackupError extends Schema.TaggedError<DurableStorageBackupError>(
  "@usine/durable/DurableStorageBackupError",
)("DurableStorageBackupError", {
  /**
   * The backup step that failed. `open`: checking or opening the durable storage file.
   * `stage`: creating the temporary copy beside `destination`. `copy`: SQLite's backup into
   * that copy. `publish`: hard-linking the copy to `destination`, which fails when a file
   * already exists there.
   */
  operation: Schema.Literals(["open", "stage", "copy", "publish"]),
  /** Path of the instance's durable storage file, `.usine/durable.sqlite` in the instance directory. */
  source: Schema.String,
  /** The destination path the caller passed to `backup`. */
  destination: Schema.String,
  /**
   * A short description of the failure for operators: the platform error's description or code,
   * SQLite's error message, or why the source is not a regular file.
   */
  reason: Schema.String,
  /** The underlying file system or SQLite error. */
  cause: Schema.Defect(),
}) {}

const errnoCode = Schema.decodeUnknownOption(Schema.Struct({ code: Schema.NonEmptyString }));

const platformReason = (cause: PlatformError.PlatformError): string => {
  if (cause.reason.description !== undefined) return cause.reason.description;
  if (cause.reason._tag !== "Unknown") return cause.reason._tag;
  return Option.match(errnoCode(cause.reason.cause), {
    onNone: () => cause.reason._tag,
    onSome: ({ code }) => code,
  });
};

const sqliteReason = (cause: unknown): string =>
  cause instanceof Error && cause.message.length > 0 ? cause.message : String(cause);

/**
 * Copies the instance's `.usine/durable.sqlite` to `destination` while the
 * orchestrator runs, through SQLite's backup API on a read-only connection, so
 * the copy holds every committed transaction, including those still in the
 * WAL. The copy is written beside the destination, then hard-linked into place,
 * so an existing file is never overwritten; the destination directory must
 * exist and support hard links. Returns false, writing nothing, when the
 * instance has no durable storage yet.
 */
export const backup = Effect.fn("DurableStorage.backup")(
  function* (instanceDirectory: InstanceDirectory, destination: string) {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const source = durableStoragePath(path, instanceDirectory);
    yield* Effect.annotateCurrentSpan({ instanceDirectory, source, destination });
    const failed =
      <C>(operation: DurableStorageBackupError["operation"], reasonOf: (cause: C) => string) =>
      (cause: C) =>
        new DurableStorageBackupError({
          operation,
          source,
          destination,
          reason: reasonOf(cause),
          cause,
        });
    if (!(yield* fileSystem.exists(source).pipe(Effect.mapError(failed("open", platformReason))))) {
      yield* Effect.logInfo("The instance has no durable storage to back up", { source });
      return false;
    }
    const info = yield* fileSystem
      .stat(source)
      .pipe(Effect.mapError(failed("open", platformReason)));
    if (info.type !== "File") {
      return yield* new DurableStorageBackupError({
        operation: "open",
        source,
        destination,
        reason: `Expected a regular SQLite file, found ${info.type}`,
        cause: new Error(info.type),
      });
    }
    yield* Effect.logInfo("Durable storage backup started", { source, destination });
    const totalPages = yield* Effect.scoped(
      Effect.gen(function* () {
        const temporary = yield* fileSystem
          .makeTempDirectoryScoped({
            directory: path.dirname(destination),
            prefix: ".usine-backup-",
          })
          .pipe(Effect.mapError(failed("stage", platformReason)));
        const staged = path.join(temporary, "durable.sqlite");
        yield* fileSystem
          .writeFile(staged, new Uint8Array(), { mode: 0o600 })
          .pipe(Effect.mapError(failed("stage", platformReason)));
        // The copy cannot be canceled; it finishes before the connection closes and staging is removed.
        const pages = yield* Effect.acquireUseRelease(
          Effect.try({
            try: () => new DatabaseSync(source, { readOnly: true, timeout: 5_000 }),
            catch: failed("open", sqliteReason),
          }),
          (database) =>
            Effect.tryPromise({
              try: () => backupDatabase(database, staged),
              catch: failed("copy", sqliteReason),
            }),
          (database) => Effect.sync(() => database.close()),
        ).pipe(Effect.uninterruptible);
        yield* fileSystem
          .link(staged, destination)
          .pipe(Effect.mapError(failed("publish", platformReason)));
        return pages;
      }),
    );
    yield* Effect.logInfo("Durable storage backup completed", { source, destination, totalPages });
    return true;
  },
  Effect.tapError((error) =>
    Effect.logWarning("Durable storage backup failed", {
      operation: error.operation,
      source: error.source,
      destination: error.destination,
      reason: error.reason,
    }),
  ),
  Effect.provide(NodeServices.layer),
);
