import { sql, type SQLWrapper } from "drizzle-orm";
import type { SqlClient } from "effect/sql/SqlClient";
import type { Fragment } from "effect/sql/Statement";

const quoted = (value: string) => `'${value.replaceAll("'", "''")}'`;

// Literal paths must match the expressions in SQLite indexes (ADR 0020).
export const jsonExtract = (value: SQLWrapper, path: string) =>
  sql`json_extract(${value}, ${sql.raw(quoted(path))})`;

export const jsonValid = (value: SQLWrapper) => sql`json_valid(${value})`;

export const jsonEach = (value: SQLWrapper, path?: string) =>
  path === undefined
    ? sql`json_each(${value})`
    : sql`json_each(${value}, ${sql.raw(quoted(path))})`;

export const jsonArrayValues = (values: ReadonlyArray<unknown>) =>
  sql`select value from ${jsonEach(sql`${JSON.stringify(values)}`)}`;

export const jsonObject = (fields: ReadonlyArray<readonly [string, SQLWrapper]>) =>
  sql`json_object(${sql.join(
    fields.flatMap(([key, value]) => [sql.raw(quoted(key)), value]),
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
export const projectMigrationDialect = (client: SqlClient) => ({
  jsonExtract: (value: Fragment, path: string) =>
    client`json_extract(${value}, ${client.literal(quoted(path))})`,
  jsonValid: (value: Fragment) => client`json_valid(${value})`,
  jsonSet: (value: Fragment, path: string, replacement: Fragment) =>
    client`json_set(${value}, ${client.literal(quoted(path))}, ${replacement})`,
  unqualified: (value: Fragment) => client`instr(${value}, '/') = 0`,
});

export const foreignKeys = {
  disable: sql`PRAGMA foreign_keys = OFF`,
  enable: sql`PRAGMA foreign_keys = ON`,
};

export const migrationNameColumn = (client: SqlClient) =>
  client`SELECT name FROM pragma_table_info('usine_migrations') WHERE name = 'name'`;

export const isTrue = (value: SQLWrapper) => sql`${value} = 1`;
