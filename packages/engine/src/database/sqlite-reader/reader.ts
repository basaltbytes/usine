import { SqliteClient } from "@effect/sql-sqlite-node";
import { Effect, Option, Schema } from "effect";
import { Reactivity } from "effect/reactivity";
import { SqlClient, Statement } from "effect/sql";
import type { Connection } from "effect/sql/SqlConnection";
import { ConnectionError, SqlError, classifySqliteError } from "effect/sql/SqlError";
import { Worker } from "node:worker_threads";
import { Response } from "./protocol.ts";
import { isReadQuery } from "./query.ts";

const connectionError = (cause: unknown) =>
  new SqlError({
    reason: new ConnectionError({
      cause,
      message: "SQLite read worker stopped",
      operation: "read",
    }),
  });
const Rows = Schema.Array(Schema.Record(Schema.String, Schema.Unknown));
const Values = Schema.Array(Schema.Array(Schema.Unknown));

const readConnection = Effect.fn("LocalSqlite.readConnection")(function* (filename: string) {
  yield* Effect.annotateCurrentSpan({ filename });
  const pending = new Map<number, (result: Effect.Effect<unknown, SqlError>) => void>();
  let stopped: SqlError | undefined;
  let sequence = 0;
  const stop = (cause: unknown) => {
    stopped = connectionError(cause);
    for (const resume of pending.values()) resume(Effect.fail(stopped));
    pending.clear();
  };
  const worker = yield* Effect.acquireRelease(
    Effect.try({
      try: () =>
        new Worker(
          new URL(import.meta.url.endsWith(".ts") ? "./worker.ts" : "./worker.js", import.meta.url),
          {
            workerData: { filename },
            execArgv: import.meta.url.endsWith(".ts") ? ["--experimental-strip-types"] : [],
          },
        ),
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
  yield* rows("SELECT 1", []);
  yield* Effect.logDebug("SQLite read worker opened", { filename });
  return { rows, values };
});

/** Keeps transactions and reserved connections on the writer; standalone SELECTs use WAL snapshots. */
export const withReadWorker = Effect.fn("LocalSqlite.withReadWorker")(function* (
  writer: SqliteClient.SqliteClient,
) {
  const reader = yield* readConnection(writer.config.filename);
  const onWriter = <A>(use: (connection: Connection) => Effect.Effect<A, SqlError>) =>
    Effect.scoped(Effect.flatMap(writer.reserve, use));
  const rows: Connection["execute"] = (sql, params, transform) => {
    if (!isReadQuery(sql))
      return onWriter((connection) => connection.execute(sql, params, transform));
    const result = reader.rows(sql, params);
    return transform === undefined ? result : Effect.map(result, transform);
  };
  const values: Connection["executeValues"] = (sql, params) =>
    isReadQuery(sql)
      ? reader.values(sql, params)
      : onWriter((connection) => connection.executeValues(sql, params));
  const connection: Connection = {
    execute: rows,
    executeUnprepared: rows,
    executeRaw: (sql, params) =>
      isReadQuery(sql)
        ? reader.rows(sql, params)
        : onWriter((connection) => connection.executeRaw(sql, params)),
    executeValues: values,
    executeValuesUnprepared: values,
    executeStream: (...args) => writer.unsafe(args[0], args[1]).stream,
  };
  const routed = yield* SqlClient.make({
    driver: writer.driver,
    acquirer: Effect.succeed(connection),
    borrower: (use) => use(connection),
    compiler: Statement.makeCompilerSqlite(),
    spanAttributes: [["db.system.name", "sqlite"]],
    transactionAcquirer: writer.reserve,
    transactionService: writer.transactionService,
  }).pipe(Effect.provide(Reactivity.layer));
  return Object.assign(routed, {
    [SqliteClient.TypeId]: SqliteClient.TypeId,
    config: writer.config,
    updateValues: writer.updateValues,
    backup: writer.backup,
    loadExtension: writer.loadExtension,
    withTransaction: writer.withTransaction,
    afterCommit: writer.afterCommit,
    reactive: writer.reactive,
    reactiveMailbox: writer.reactiveMailbox,
  });
});
