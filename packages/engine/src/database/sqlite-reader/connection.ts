import { Deferred, Effect, Option, Ref, Schema, Semaphore, type Scope } from "effect";
import { SqlClient } from "effect/sql";
import { ConnectionError, SqlError, classifySqliteError } from "effect/sql/SqlError";
import { Worker } from "node:worker_threads";
import { type Command, Response } from "./protocol.ts";

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

export interface ReadQueries {
  readonly rows: (
    sql: string,
    params: ReadonlyArray<unknown>,
  ) => Effect.Effect<typeof Rows.Type, SqlError>;
  readonly values: (
    sql: string,
    params: ReadonlyArray<unknown>,
  ) => Effect.Effect<typeof Values.Type, SqlError>;
}

export interface ReadConnection extends ReadQueries {
  readonly snapshot: <A, E, R>(
    use: (queries: ReadQueries) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | SqlError, R>;
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
  const stopped = yield* Ref.make(Option.none<SqlError>());
  const access = yield* Semaphore.make(1);
  const failure = yield* Deferred.make<never, SqlError>();
  const sequence = yield* Ref.make(0);
  const stop = (cause: unknown) => {
    if (Option.isSome(Ref.getUnsafe(stopped))) return;
    const error = connectionError(cause);
    run(Ref.set(stopped, Option.some(error)));
    // Publish fallback before resuming failed reads.
    run(onStopped);
    Deferred.doneUnsafe(failure, Effect.fail(error));
    for (const resume of pending.values()) resume(Effect.fail(error));
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
  const request = (command: Command) =>
    Effect.flatMap(
      Ref.updateAndGet(sequence, (id) => id + 1),
      (id) =>
        Effect.callback<unknown, SqlError>((resume) => {
          const unavailable = Ref.getUnsafe(stopped);
          if (Option.isSome(unavailable)) {
            resume(Effect.fail(unavailable.value));
            return;
          }
          pending.set(id, resume);
          try {
            worker.postMessage({ id, command });
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
  const queries = (session: number | null): ReadQueries => {
    const query = (sql: string, params: ReadonlyArray<unknown>, values: boolean) =>
      Effect.flatMap(Effect.service(SqlClient.SafeIntegers), (safeIntegers) =>
        request({ _tag: "Query", session, sql, params, values, safeIntegers }),
      );
    return {
      rows: (sql, params) =>
        query(sql, params, false).pipe(
          Effect.flatMap((result) =>
            Schema.decodeUnknownEffect(Rows)(result).pipe(Effect.mapError(connectionError)),
          ),
        ),
      values: (sql, params) =>
        query(sql, params, true).pipe(
          Effect.flatMap((result) =>
            Schema.decodeUnknownEffect(Values)(result).pipe(Effect.mapError(connectionError)),
          ),
        ),
    };
  };
  const standalone = queries(null);
  const snapshot: ReadConnection["snapshot"] = (use) =>
    access.withPermit(
      Effect.scoped(
        Effect.gen(function* () {
          const closed = yield* Ref.make(false);
          const session = yield* Effect.acquireRelease(
            request({ _tag: "BeginSnapshot" }).pipe(
              Effect.flatMap((result) => Schema.decodeUnknownEffect(Schema.Int)(result)),
              Effect.mapError(connectionError),
            ),
            (session) =>
              Effect.gen(function* () {
                if (yield* Ref.get(closed)) return;
                yield* request({ _tag: "EndSnapshot", session, commit: false }).pipe(
                  Effect.tap(() =>
                    Effect.logDebug("SQLite read snapshot rolled back", { filename, session }),
                  ),
                  Effect.catch((error) =>
                    Effect.gen(function* () {
                      yield* Effect.logError(
                        "SQLite read snapshot cleanup failed; retiring worker",
                        { filename, session, error },
                      );
                      yield* Effect.sync(() => stop(error));
                    }),
                  ),
                );
              }),
          );
          yield* Effect.annotateCurrentSpan({ filename, session });
          yield* Effect.logDebug("SQLite read snapshot opened", { filename, session });
          const result = yield* use(queries(session));
          yield* Effect.uninterruptible(
            request({ _tag: "EndSnapshot", session, commit: true }).pipe(
              Effect.andThen(Ref.set(closed, true)),
            ),
          );
          yield* Effect.logDebug("SQLite read snapshot committed", { filename, session });
          return result;
        }),
      ),
    );
  return {
    rows: (sql, params) => access.withPermit(standalone.rows(sql, params)),
    values: (sql, params) => access.withPermit(standalone.values(sql, params)),
    snapshot,
    failure: Deferred.await(failure),
  };
});
