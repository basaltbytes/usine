import { getTableName } from "drizzle-orm";
import { DateTime, Effect, Layer, Option, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { make as makeMigrator, fromRecord } from "effect/sql/Migrator";
import { ConfigParser } from "../../parser.ts";
import { commit, validateConfiguration } from "../commit.ts";
import { configurationEntities } from "../entities.ts";
import {
  Configuration,
  ConfigurationEntity,
  ConfigurationRevision,
  ConfigurationRevisionNumber,
  ConfigurationStoreError,
} from "../model.ts";
import { ConfigurationStore, type ConfigurationCommit } from "../store.ts";
import { watchRevisions } from "../watch.ts";
import { migrations } from "./migrations.ts";
import { configurationEntitiesTable, configurationRevisionsTable } from "./schema.ts";

const EntityJson = Schema.fromJsonString(Schema.toCodecJson(ConfigurationEntity));
const RevisionJson = Schema.fromJsonString(Schema.toCodecJson(ConfigurationRevision));
const Row = Schema.Struct({ value: Schema.String });
const entityTable = getTableName(configurationEntitiesTable);
const revisionTable = getTableName(configurationRevisionsTable);

/** Uses the application's SqlClient; migrations have a separate ledger from the runtime engine. */
export const sqliteConfigurationLayer = Layer.effect(
  ConfigurationStore,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const parser = yield* ConfigParser;
    const failure = (operation: string) => (cause: unknown) =>
      new ConfigurationStoreError({ operation, cause });
    yield* makeMigrator({})({
      table: "usine_configuration_migrations",
      loader: fromRecord(
        Object.fromEntries(
          migrations.map(([name, statements]) => [
            name,
            Effect.forEach(statements, (statement) => sql.unsafe(statement), { discard: true }),
          ]),
        ),
      ),
    }).pipe(Effect.mapError(failure("migrate configuration")));

    const revisionsAfter = Effect.fn("ConfigurationStore.revisionsAfter")(
      function* (number: ConfigurationRevisionNumber) {
        const rows =
          yield* sql`SELECT value FROM ${sql(revisionTable)} WHERE number > ${number} ORDER BY number`;
        return yield* Effect.forEach(rows, (row) =>
          Schema.decodeUnknownEffect(Row)(row).pipe(
            Effect.flatMap(({ value }) => Schema.decodeUnknownEffect(RevisionJson)(value)),
          ),
        );
      },
      Effect.mapError(failure("read revisions")),
    );

    const read = Effect.gen(function* () {
      const rows =
        yield* sql`SELECT number FROM ${sql(revisionTable)} ORDER BY number DESC LIMIT 1`;
      const row = rows[0];
      if (row === undefined) return Configuration.empty;
      const { number } = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ number: ConfigurationRevisionNumber }),
      )(row);
      const stored = yield* sql`SELECT value FROM ${sql(entityTable)} ORDER BY position`;
      const entities = yield* Effect.forEach(stored, (entry) =>
        Schema.decodeUnknownEffect(Row)(entry).pipe(
          Effect.flatMap(({ value }) => Schema.decodeUnknownEffect(EntityJson)(value)),
        ),
      );
      const instance = yield* validateConfiguration(parser, entities);
      return new Configuration({ number, instance: Option.some(instance) });
    });

    return ConfigurationStore.of({
      read: read.pipe(
        sql.withTransaction,
        Effect.mapError(failure("read configuration")),
        Effect.withSpan("ConfigurationStore.read"),
      ),
      list: Effect.fn("ConfigurationStore.list")(function* (entity) {
        const revisions = yield* revisionsAfter(ConfigurationRevisionNumber.make(0));
        return revisions.filter(
          (revision) =>
            Option.isNone(entity) ||
            revision.changes.some(({ key }) => key.key === entity.value.key),
        );
      }),
      revision: Effect.fn("ConfigurationStore.revision")(
        function* (number) {
          const rows = yield* sql`SELECT value FROM ${sql(revisionTable)} WHERE number = ${number}`;
          const row = rows[0];
          if (row === undefined) return Option.none();
          const { value } = yield* Schema.decodeUnknownEffect(Row)(row);
          return Option.some(yield* Schema.decodeUnknownEffect(RevisionJson)(value));
        },
        Effect.mapError(failure("read revision")),
      ),
      commit: Effect.fn("ConfigurationStore.commit")(
        function* (request: ConfigurationCommit) {
          yield* Effect.annotateCurrentSpan({ expectedRevision: request.expected });
          const revision = yield* Effect.gen(function* () {
            const current = yield* read.pipe(
              Effect.mapError(failure("read configuration for commit")),
            );
            const result = yield* commit(parser, current, request.expected, request.changes, {
              actor: request.actor,
              message: request.message,
              time: yield* DateTime.now,
            });
            const value = yield* Schema.encodeEffect(RevisionJson)(result.revision).pipe(
              Effect.mapError(failure("encode revision")),
            );
            yield* sql`INSERT INTO ${sql(revisionTable)} ${sql.insert({ number: result.revision.number, value })}`;
            for (const change of result.revision.changes) {
              if (Option.isNone(change.after))
                yield* sql`DELETE FROM ${sql(entityTable)} WHERE key = ${change.key.key}`;
            }
            const entities = Option.match(result.configuration.instance, {
              onNone: () => [],
              onSome: configurationEntities,
            });
            yield* Effect.forEach(
              entities,
              (entity, position) =>
                Effect.gen(function* () {
                  const encoded = yield* Schema.encodeEffect(EntityJson)(entity).pipe(
                    Effect.mapError(failure("encode entity")),
                  );
                  yield* sql`INSERT INTO ${sql(entityTable)} ${sql.insert({ key: entity.key.key, position, value: encoded })}
            ON CONFLICT(key) DO UPDATE SET position = excluded.position, value = excluded.value`;
                }),
              { discard: true },
            );
            return result.revision;
          }).pipe(
            sql.withTransaction,
            Effect.provideService(SqlClient.BeginTransaction, "BEGIN IMMEDIATE"),
            Effect.catchTag("SqlError", (cause) =>
              Effect.fail(failure("commit configuration")(cause)),
            ),
          );
          yield* Effect.logInfo("Configuration revision committed", {
            revision: revision.number,
            changes: revision.changes.length,
          });
          return revision;
        },
        Effect.tapError((error) =>
          Effect.logWarning("Configuration commit refused", { errorTag: error._tag }),
        ),
      ),
      changes: (number) => watchRevisions(number, revisionsAfter),
    });
  }),
);
