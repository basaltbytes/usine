import { DatabaseSync } from "node:sqlite";
import type { InstanceDirectory } from "@usine/core/instance";
import { Effect, FileSystem, Option, Path, Schema } from "effect";

/** Another `usine up` holds the instance folder, possibly still draining its Attempts. */
export class InstanceInUseError extends Schema.TaggedError<InstanceInUseError>(
  "@usine/server/InstanceInUseError",
)("InstanceInUseError", {
  directory: Schema.String,
  /** The holder's process id, when it could be read. */
  holder: Schema.Option(Schema.Int),
}) {}

/** The instance folder's lock could not be created or taken for a reason other than another holder. */
export class InstanceLockError extends Schema.TaggedError<InstanceLockError>(
  "@usine/server/InstanceLockError",
)("InstanceLockError", { directory: Schema.String, reason: Schema.String }) {}

/** node:sqlite's failure when another connection holds the lock: SQLite's `SQLITE_BUSY` result. */
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

/**
 * Holds the instance folder for the scope, so only one `usine up` opens its
 * runtime and durable stores: two processes on one durable storage corrupt
 * it. The lock is an exclusive SQLite transaction on `.usine/instance.lock`,
 * which the operating system releases when the process exits, however it
 * exits. The holder writes its process id to `.usine/instance.pid` for the
 * refusal message.
 */
export const holdInstance = Effect.fn("Server.holdInstance")(function* (
  directory: InstanceDirectory,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const folder = path.join(directory, ".usine");
  const pidFile = path.join(folder, "instance.pid");
  const lockError = (cause: unknown) =>
    new InstanceLockError({ directory, reason: reasonOf(cause) });
  const refuse = Effect.fn("Server.refuseInstance")(function* (cause: unknown) {
    if (!Schema.is(SqliteBusy)(cause)) return yield* lockError(cause);
    const holder = yield* fileSystem.readFileString(pidFile).pipe(
      Effect.map((text) => Option.fromNullishOr(Number.parseInt(text, 10) || undefined)),
      Effect.orElseSucceed(() => Option.none<number>()),
    );
    yield* Effect.logWarning("Another usine process holds the instance folder", {
      instanceDirectory: directory,
      holder: Option.getOrUndefined(holder),
    });
    return yield* new InstanceInUseError({ directory, holder });
  });
  yield* fileSystem.makeDirectory(folder, { recursive: true }).pipe(Effect.mapError(lockError));
  yield* Effect.acquireRelease(
    Effect.try({
      try: () => takeLock(path.join(folder, "instance.lock")),
      catch: (cause) => cause,
    }),
    (database) => Effect.sync(() => database.close()),
  ).pipe(Effect.catch(refuse));
  yield* fileSystem.writeFileString(pidFile, `${process.pid}\n`).pipe(Effect.mapError(lockError));
  yield* Effect.logInfo("Holding the instance folder", {
    instanceDirectory: directory,
    pid: process.pid,
  });
});
