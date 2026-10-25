import { DatabaseSync } from "node:sqlite";
import type { InstanceDirectory } from "@usine/core/instance";
import { Effect, FileSystem, Option, Schema } from "effect";
import {
  type InstanceFiles,
  type InstanceRecord,
  ProcessId,
  instanceFiles,
  markStoppingSync,
  readPid,
  writeRecord,
} from "./record.ts";

/** Another `usine up` has the instance lock, possibly while still draining its Attempts. */
export class InstanceInUseError extends Schema.TaggedError<InstanceInUseError>(
  "@usine/server/InstanceInUseError",
)("InstanceInUseError", {
  directory: Schema.String,
  /** The PID of the lock holder, if it could be read. */
  holder: Schema.Option(ProcessId),
}) {}

/** The instance lock could not be created or acquired for a reason other than another holder. */
export class InstanceLockError extends Schema.TaggedError<InstanceLockError>(
  "@usine/server/InstanceLockError",
)("InstanceLockError", { directory: Schema.String, reason: Schema.String }) {}

/** The node:sqlite error when another connection has the lock (`SQLITE_BUSY`). */
const SqliteBusy = Schema.Struct({ errcode: Schema.Literal(5) });

const reasonOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

const takeLock = (file: string) => {
  const database = new DatabaseSync(file, { timeout: 0 });
  try {
    database.exec("BEGIN EXCLUSIVE");
  } catch (cause) {
    database.close();
    throw cause;
  }
  return database;
};

/** Returns whether a process holds the instance lock, without creating the lock file. */
export const lockHeld = Effect.fn("Instance.lockHeld")(function* (files: InstanceFiles) {
  const fileSystem = yield* FileSystem.FileSystem;
  const lockError = (cause: unknown) =>
    new InstanceLockError({ directory: files.folder, reason: reasonOf(cause) });
  if (!(yield* fileSystem.exists(files.lock).pipe(Effect.mapError(lockError)))) return false;
  return yield* Effect.try({
    try: () => {
      // The holder's exclusive transaction blocks readers, so a read fails with SQLITE_BUSY.
      const database = new DatabaseSync(files.lock, { readOnly: true, timeout: 0 });
      try {
        database.prepare("SELECT count(*) FROM sqlite_master").get();
        return false;
      } catch (cause) {
        if (Schema.is(SqliteBusy)(cause)) return true;
        throw cause;
      } finally {
        database.close();
      }
    },
    catch: lockError,
  });
});

const removeFile = (fileSystem: FileSystem.FileSystem, path: string) =>
  fileSystem.remove(path, { force: true }).pipe(
    Effect.tapError((error) =>
      Effect.logWarning("Could not remove an instance file on exit", {
        path,
        message: error.message,
      }),
    ),
    Effect.ignore,
  );

/**
 * Records the `stoppingSince` of the process on its first `SIGINT` or `SIGTERM`, so that `usine stop`
 * doesn't send a second signal that would end the drain.
 */
const markStoppingOnSignal = (files: InstanceFiles, record: InstanceRecord) =>
  Effect.gen(function* () {
    const context = yield* Effect.context();
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        let marked = false;
        const onSignal = () => {
          if (marked) return;
          marked = true;
          try {
            markStoppingSync(files, record);
          } catch (cause) {
            Effect.runForkWith(context)(
              Effect.logWarning("Could not record that the instance is stopping", {
                path: files.record,
                cause,
              }),
            );
          }
        };
        process.prependListener("SIGINT", onSignal);
        process.prependListener("SIGTERM", onSignal);
        return onSignal;
      }),
      (onSignal) =>
        Effect.sync(() => {
          process.removeListener("SIGINT", onSignal);
          process.removeListener("SIGTERM", onSignal);
        }),
    );
  });

/**
 * Acquires the instance lock for the scope, so only one `usine up` opens the stores. The lock is an
 * exclusive SQLite transaction on `.usine/instance.lock`, released by the OS on exit. Writes
 * `.usine/instance.pid` and `.usine/instance.json`, and removes both when the scope closes.
 */
export const holdInstance = Effect.fn("Server.holdInstance")(function* (
  directory: InstanceDirectory,
  record: InstanceRecord,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const files = instanceFiles(directory);
  const lockError = (cause: unknown) =>
    new InstanceLockError({ directory, reason: reasonOf(cause) });
  const refuse = Effect.fn("Server.refuseInstance")(function* (cause: unknown) {
    if (!Schema.is(SqliteBusy)(cause)) return yield* lockError(cause);
    const holder = yield* readPid(files);
    yield* Effect.logWarning("Another usine process holds the instance folder", {
      instanceDirectory: directory,
      holder: Option.getOrUndefined(holder),
    });
    return yield* new InstanceInUseError({ directory, holder });
  });
  yield* fileSystem
    .makeDirectory(files.folder, { recursive: true })
    .pipe(Effect.mapError(lockError));
  yield* Effect.acquireRelease(
    Effect.try({
      try: () => takeLock(files.lock),
      catch: (cause) => cause,
    }),
    (database) => Effect.sync(() => database.close()),
  ).pipe(Effect.catch(refuse));
  yield* Effect.acquireRelease(
    Effect.all([
      fileSystem.writeFileString(files.pid, `${record.pid}\n`),
      writeRecord(files, record),
    ]).pipe(Effect.mapError(lockError)),
    () =>
      Effect.all([removeFile(fileSystem, files.record), removeFile(fileSystem, files.pid)], {
        discard: true,
      }),
  );
  yield* markStoppingOnSignal(files, record);
  yield* Effect.logInfo("Holding the instance folder", {
    instanceDirectory: directory,
    pid: record.pid,
    version: record.version,
  });
});
