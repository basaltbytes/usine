import { SqliteClient } from "@effect/sql-sqlite-node";
import { Data, Deferred, Duration, Effect, Match, Option, Ref, Schedule } from "effect";
import { Reactivity } from "effect/reactivity";
import { SqlClient, Statement } from "effect/sql";
import type { Connection } from "effect/sql/SqlConnection";
import type { SqlError } from "effect/sql/SqlError";
import { connectionError, readConnection, spawnWorker, type ReadConnection } from "./connection.ts";
import type { SqliteReaderState } from "./status.ts";
import { isReadQuery } from "./query.ts";

type ReaderState = Data.TaggedEnum<{
  Worker: { readonly reader: ReadConnection };
  Fallback: { readonly attempt: number };
  Respawning: { readonly attempt: number };
}>;
const ReaderState = Data.taggedEnum<ReaderState>();

const supervise = Effect.fn("LocalSqlite.superviseReader")(function* (
  filename: string,
  spawn: typeof spawnWorker,
) {
  yield* Effect.annotateCurrentSpan({ filename });
  const state = yield* Ref.make<ReaderState>(ReaderState.Respawning({ attempt: 0 }));
  const initialized = yield* Deferred.make<void>();
  const fallback = Ref.update(state, (current) =>
    Match.valueTags(current, {
      Worker: () => ReaderState.Fallback({ attempt: 0 }),
      Fallback: (current) => current,
      Respawning: ({ attempt }) => ReaderState.Fallback({ attempt }),
    }),
  );
  const start = Effect.fn("LocalSqlite.startReader")(function* () {
    yield* Effect.annotateCurrentSpan({ filename });
    const attempt = yield* Ref.modify(state, (current) => {
      const starting = ReaderState.Respawning({
        attempt: Match.valueTags(current, {
          Worker: () => 0,
          Fallback: ({ attempt }) => attempt + 1,
          Respawning: ({ attempt }) => attempt,
        }),
      });
      return [starting.attempt, starting];
    });
    yield* Effect.logInfo("SQLite read worker starting", { filename, attempt });
    const reader = yield* readConnection(filename, spawn, fallback);
    yield* reader.rows("SELECT 1", []).pipe(
      Effect.timeoutOrElse({
        duration: "5 seconds",
        orElse: () => Effect.fail(connectionError("SQLite reader probe timed out")),
      }),
    );
    yield* Ref.set(state, ReaderState.Worker({ reader }));
    yield* Effect.logInfo("SQLite read worker ready; retry delay reset", { filename });
    yield* Deferred.succeed(initialized, undefined);
    return reader;
  });
  const cycle = Effect.scoped(Effect.flatMap(start(), (reader) => reader.failure)).pipe(
    Effect.tapError(() => fallback),
    Effect.tapError((error) =>
      Effect.logError("SQLite read worker unavailable; using main connection", {
        filename,
        cause: error.reason.cause,
      }),
    ),
    Effect.tapError(() => Deferred.succeed(initialized, undefined)),
  );
  const backoff = Schedule.spaced("5 minutes").pipe(
    Schedule.modifyDelay(() =>
      Ref.get(state).pipe(
        Effect.map((current) =>
          Match.valueTags(current, {
            Worker: () => Duration.seconds(1),
            Respawning: () => Duration.seconds(1),
            Fallback: ({ attempt }) => {
              switch (attempt) {
                case 0:
                  return Duration.seconds(1);
                case 1:
                  return Duration.seconds(5);
                case 2:
                  return Duration.seconds(30);
                default:
                  return Duration.minutes(5);
              }
            },
          }),
        ),
      ),
    ),
    Schedule.tap(({ duration }) =>
      Effect.logInfo("SQLite read worker retry scheduled", {
        filename,
        delayMs: Duration.toMillis(duration),
      }),
    ),
  );
  yield* cycle.pipe(Effect.retry(backoff), Effect.forkScoped);
  yield* Deferred.await(initialized);
  return {
    current: Ref.get(state).pipe(
      Effect.map((current) =>
        Match.valueTags(current, {
          Worker: ({ reader }) => Option.some(reader),
          Fallback: () => Option.none<ReadConnection>(),
          Respawning: () => Option.none<ReadConnection>(),
        }),
      ),
    ),
    state: Ref.get(state).pipe(
      Effect.map((current): SqliteReaderState =>
        Match.valueTags(current, {
          Worker: (): SqliteReaderState => "worker",
          Fallback: (): SqliteReaderState => "fallback",
          Respawning: (): SqliteReaderState => "respawning",
        }),
      ),
    ),
  };
});

// The routed service must satisfy SqliteClient because Drizzle and Node-specific consumers share it.
const routedSqliteClient = (
  routed: SqlClient.SqlClient,
  writer: SqliteClient.SqliteClient,
): SqliteClient.SqliteClient =>
  Object.assign(routed, {
    [SqliteClient.TypeId]: SqliteClient.TypeId,
    config: writer.config,
    updateValues: writer.updateValues,
    backup: writer.backup,
    loadExtension: writer.loadExtension,
    withTransaction: writer.withTransaction,
    afterCommit: writer.afterCommit,
    reactive: writer.reactive,
    reactiveMailbox: writer.reactiveMailbox,
  } satisfies Partial<SqliteClient.SqliteClient>);

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
    onReader: (current: ReadConnection) => Effect.Effect<A, SqlError>,
    useWriter: (connection: Connection) => Effect.Effect<A, SqlError>,
  ) =>
    isReadQuery(sql)
      ? Effect.flatMap(
          reader.current,
          Option.match({
            onSome: onReader,
            onNone: () => onWriter(useWriter),
          }),
        )
      : onWriter(useWriter);
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
  return { client: routedSqliteClient(routed, writer), state: reader.state };
});
