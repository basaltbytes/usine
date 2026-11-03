import { Deferred, Effect, Option, Schema, type Scope } from "effect";
import { SqlClient } from "effect/sql";
import { ConnectionError, SqlError, classifySqliteError } from "effect/sql/SqlError";
import { Worker } from "node:worker_threads";
import { Response } from "./protocol.ts";

export const spawnWorker = (filename: string) =>
  new Worker(
    new URL(import.meta.url.endsWith(".ts") ? "./worker.ts" : "./worker.js", import.meta.url),
    {
      workerData: { filename },
      execArgv: import.meta.url.endsWith(".ts") ? ["--experimental-strip-types"] : [],
    },
  );

export const connectionError = (cause: unknown) =>
  new SqlError({
    reason: new ConnectionError({
      cause,
      message: "SQLite read worker stopped",
      operation: "read",
    }),
  });
const Rows = Schema.Array(Schema.Record(Schema.String, Schema.Unknown));
const Values = Schema.Array(Schema.Array(Schema.Unknown));

export interface ReadConnection {
  readonly rows: (
    sql: string,
    params: ReadonlyArray<unknown>,
  ) => Effect.Effect<typeof Rows.Type, SqlError>;
  readonly values: (
    sql: string,
    params: ReadonlyArray<unknown>,
  ) => Effect.Effect<typeof Values.Type, SqlError>;
  readonly failure: Effect.Effect<never, SqlError>;
}

export const readConnection = Effect.fn("LocalSqlite.readConnection")(function* (
  filename: string,
  spawn: typeof spawnWorker,
  onStopped: Effect.Effect<void>,
): Effect.fn.Return<ReadConnection, SqlError, Scope.Scope> {
  yield* Effect.annotateCurrentSpan({ filename });
  const run = Effect.runForkWith(yield* Effect.context<never>());
  const pending = new Map<number, (result: Effect.Effect<unknown, SqlError>) => void>();
  let stopped: SqlError | undefined;
  const failure = yield* Deferred.make<never, SqlError>();
  let sequence = 0;
  const stop = (cause: unknown) => {
    if (stopped !== undefined) return;
    stopped = connectionError(cause);
    // Publish fallback before resuming failed reads.
    run(onStopped);
    Deferred.doneUnsafe(failure, Effect.fail(stopped));
    for (const resume of pending.values()) resume(Effect.fail(stopped));
    pending.clear();
  };
  const worker = yield* Effect.acquireRelease(
    Effect.try({
      try: () => spawn(filename),
      catch: connectionError,
    }),
    (worker) =>
      Effect.gen(function* () {
        stop("SQLite reader scope closed");
        yield* Effect.promise(() => worker.terminate());
      }),
  );
  worker.on("error", stop);
  worker.on("exit", (code) => stop(`SQLite reader exited with code ${code}`));
  worker.on("message", (message) => {
    const decoded = Schema.decodeUnknownOption(Response)(message);
    if (Option.isNone(decoded)) {
      stop("Invalid SQLite reader response");
      return;
    }
    const response = decoded.value;
    const resume = pending.get(response.id);
    pending.delete(response.id);
    resume?.(
      response.ok
        ? Effect.succeed(response.result)
        : Effect.fail(
            new SqlError({
              reason: classifySqliteError(response.cause, {
                message: response.cause.message,
                operation: "execute",
              }),
            }),
          ),
    );
  });
  const request = (sql: string, params: ReadonlyArray<unknown>, values: boolean) =>
    Effect.flatMap(Effect.service(SqlClient.SafeIntegers), (safeIntegers) =>
      Effect.callback<unknown, SqlError>((resume) => {
        if (stopped !== undefined) {
          resume(Effect.fail(stopped));
          return;
        }
        const id = ++sequence;
        pending.set(id, resume);
        try {
          worker.postMessage({ id, sql, params, values, safeIntegers });
        } catch (cause) {
          pending.delete(id);
          resume(Effect.fail(connectionError(cause)));
        }
        return Effect.sync(() => {
          pending.delete(id);
        });
      }),
    ).pipe(
      Effect.tapError((error) =>
        Effect.logError("SQLite read failed", {
          filename,
          reason: error.reason._tag,
        }),
      ),
    );
  const rows = (sql: string, params: ReadonlyArray<unknown>) =>
    request(sql, params, false).pipe(
      Effect.flatMap((result) =>
        Schema.decodeUnknownEffect(Rows)(result).pipe(Effect.mapError(connectionError)),
      ),
    );
  const values = (sql: string, params: ReadonlyArray<unknown>) =>
    request(sql, params, true).pipe(
      Effect.flatMap((result) =>
        Schema.decodeUnknownEffect(Values)(result).pipe(Effect.mapError(connectionError)),
      ),
    );
  return { rows, values, failure: Deferred.await(failure) };
});
