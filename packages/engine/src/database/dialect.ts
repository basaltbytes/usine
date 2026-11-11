import { Schema } from "effect";
import type { Statement, SqlClient } from "effect/sql";

import { sql, type SQLWrapper } from "drizzle-orm";

const quoted = (value: string) => `'${value.replaceAll("'", "''")}'`;

// Literal paths must match the expressions in SQLite indexes.
export const jsonExtract = (value: SQLWrapper, path: string) =>
  sql`json_extract(${value}, ${sql.raw(quoted(path))})`;

export const jsonValid = (value: SQLWrapper) => sql`json_valid(${value})`;

export const jsonEach = (value: SQLWrapper, path?: string) =>
  path === undefined
    ? sql`json_each(${value})`
    : sql`json_each(${value}, ${sql.raw(quoted(path))})`;

// jsonArrayValues synchronously constructs a Drizzle SQL fragment for identifier membership.
// @effect-diagnostics-next-line schemaSync:off
const encodeIdentifiers = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));

export const jsonArrayValues = (values: ReadonlyArray<string>) =>
  sql`select value from ${jsonEach(sql`${encodeIdentifiers(values)}`)}`;

export const jsonObject = (fields: ReadonlyArray<readonly [string, SQLWrapper]>) =>
  sql`json_object(${sql.join(
    fields.flatMap(([key, value]) => [sql.raw(quoted(key)), value]),
    sql`, `,
  )})`;

export const jsonSet = (value: SQLWrapper, fields: ReadonlyArray<readonly [string, SQLWrapper]>) =>
  sql<string>`json_set(${value}, ${sql.join(
    fields.flatMap(([path, replacement]) => [sql.raw(quoted(path)), replacement]),
    sql`, `,
  )})`;

export const jsonValue = (value: SQLWrapper) => sql`json(${value})`;

export const jsonGroupArray = (value: SQLWrapper, filter: SQLWrapper) =>
  sql<string>`json_group_array(${value}) filter (where ${filter})`;

/** Returns elapsed milliseconds, rounded and clamped to zero. */
export const elapsedMillis = (start: SQLWrapper, end: SQLWrapper) =>
  sql<number>`max(0, round((julianday(${end}) - julianday(${start})) * 86400000))`;

export const distinctFrom = (left: SQLWrapper, right: SQLWrapper) => sql`${left} IS NOT ${right}`;

/** SQLite fragments for the historical project migration, which uses Effect SQL. */
export const projectMigrationDialect = (client: SqlClient.SqlClient) => ({
  jsonExtract: (value: Statement.Fragment, path: string) =>
    client`json_extract(${value}, ${client.literal(quoted(path))})`,
  jsonValid: (value: Statement.Fragment) => client`json_valid(${value})`,
  jsonSet: (value: Statement.Fragment, path: string, replacement: Statement.Fragment) =>
    client`json_set(${value}, ${client.literal(quoted(path))}, ${replacement})`,
  unqualified: (value: Statement.Fragment) => client`instr(${value}, '/') = 0`,
});

export const foreignKeys = {
  disable: sql`PRAGMA foreign_keys = OFF`,
  enable: sql`PRAGMA foreign_keys = ON`,
};

export const migrationNameColumn = (client: SqlClient.SqlClient) =>
  client`SELECT name FROM pragma_table_info('usine_migrations') WHERE name = 'name'`;

export const isTrue = (value: SQLWrapper) => sql`${value} = 1`;
