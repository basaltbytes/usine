import { SqliteClient } from "@effect/sql-sqlite-node";
import { Deferred, Effect } from "effect";
import { Reactivity } from "effect/reactivity";
import { SqlClient, Statement } from "effect/sql";
import type { Connection } from "effect/sql/SqlConnection";
import type { SqlError } from "effect/sql/SqlError";
import { connectionError, readConnection, spawnWorker } from "./connection.ts";
import type { SqliteReaderState } from "./status.ts";
import { isReadQuery } from "./query.ts";

const retryDelays = [1000, 5000, 30000];

const supervise = Effect.fn("LocalSqlite.superviseReader")(function* (
  filename: string,
  spawn: typeof spawnWorker,
) {
  yield* Effect.annotateCurrentSpan({ filename });
  type Reader = Effect.Success<ReturnType<typeof readConnection>>;
  let active: Reader | undefined;
  let state: SqliteReaderState = "respawning";
  let attempt = 0;
  const initialized = yield* Deferred.make<void>();
  const cycle = Effect.gen(function* () {
    state = "respawning";
    yield* Effect.logInfo("SQLite read worker starting", { filename, attempt });
    yield* Effect.scoped(
      Effect.gen(function* () {
        const reader = yield* readConnection(filename, spawn);
        yield* reader.rows("SELECT 1", []).pipe(
          Effect.timeoutOrElse({
            duration: "5 seconds",
            orElse: () => Effect.fail(connectionError("SQLite reader probe timed out")),
          }),
        );
        active = reader;
        state = "worker";
        attempt = 0;
        yield* Effect.logInfo("SQLite read worker ready", { filename });
        yield* Deferred.succeed(initialized, undefined);
        return yield* reader.failure;
      }),
    ).pipe(
      Effect.catchTag("SqlError", (error) =>
        Effect.gen(function* () {
          active = undefined;
          state = "fallback";
          const delayMs = retryDelays[attempt] ?? 300000;
          attempt++;
          yield* Effect.logError("SQLite read worker unavailable; using main connection", {
            filename,
            cause: error.reason.cause,
            attempt,
            delayMs,
          });
          yield* Deferred.succeed(initialized, undefined);
          yield* Effect.sleep(delayMs);
        }),
      ),
    );
  });
  yield* cycle.pipe(Effect.forever, Effect.forkScoped);
  yield* Deferred.await(initialized);
  return {
    current: () => (active?.available() ? active : undefined),
    state: Effect.sync(() => (active !== undefined && !active.available() ? "fallback" : state)),
  };
});

/** Keeps transactions and reserved connections on the writer; standalone SELECTs use WAL snapshots. */
export const withReadWorker = Effect.fn("LocalSqlite.withReadWorker")(function* (
  writer: SqliteClient.SqliteClient,
  spawn: typeof spawnWorker = spawnWorker,
) {
  yield* Effect.annotateCurrentSpan({ filename: writer.config.filename });
  const reader = yield* supervise(writer.config.filename, spawn);
  const onWriter = <A>(use: (connection: Connection) => Effect.Effect<A, SqlError>) =>
    Effect.scoped(Effect.flatMap(writer.reserve, use));
  const route = <A>(
    sql: string,
    onReader: (
      current: NonNullable<ReturnType<typeof reader.current>>,
    ) => Effect.Effect<A, SqlError>,
    useWriter: (connection: Connection) => Effect.Effect<A, SqlError>,
  ) =>
    Effect.suspend(() => {
      const current = reader.current();
      return isReadQuery(sql) && current !== undefined ? onReader(current) : onWriter(useWriter);
    });
  const rows: Connection["execute"] = (sql, params, transform) =>
    route(
      sql,
      (current) => {
        const result = current.rows(sql, params);
        return transform === undefined ? result : Effect.map(result, transform);
      },
      (connection) => connection.execute(sql, params, transform),
    );
  const values: Connection["executeValues"] = (sql, params) =>
    route(
      sql,
      (current) => current.values(sql, params),
      (connection) => connection.executeValues(sql, params),
    );
  const connection: Connection = {
    execute: rows,
    executeUnprepared: rows,
    executeRaw: (sql, params) =>
      route(
        sql,
        (current) => current.rows(sql, params),
        (connection) => connection.executeRaw(sql, params),
      ),
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
  const client = Object.assign(routed, {
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
  return { client, state: reader.state };
});
