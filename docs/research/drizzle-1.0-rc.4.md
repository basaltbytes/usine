# Drizzle ORM 1.0.0-rc.4: Effect SQLite and D1

Research date: 2026-08-25. Sources: Drizzle, Effect, npm, and Cloudflare material only.

## Finding

`drizzle-orm@1.0.0-rc.4`, the first numbered RC with Effect-native SQLite sessions, exports `drizzle-orm/effect-sqlite-node`, `drizzle-orm/effect-d1`, `drizzle-orm/effect-libsql`, and SQLite variants for Bun, Durable Objects, and Wasm. Pin it exactly: it's a prerelease, and its SQLite session API changed substantially. [RC.4 release](https://github.com/drizzle-team/drizzle-orm/releases/tag/v1.0.0-rc.4), [RC.3 release](https://github.com/drizzle-team/drizzle-orm/releases/tag/v1.0.0-rc.3), [npm package](https://www.npmjs.com/package/drizzle-orm/v/1.0.0-rc.4)

The drivers wrap Effect clients, not Promises: Node takes `SqliteClient` from `@effect/sql-sqlite-node`, and D1 takes `D1Client` from `@effect/sql-d1`. Both build the same SQLite Effect database with Effect-yieldable query builders. [Node driver](https://github.com/drizzle-team/drizzle-orm/blob/v1.0.0-rc.4/drizzle-orm/src/effect-sqlite-node/driver.ts), [D1 driver](https://github.com/drizzle-team/drizzle-orm/blob/v1.0.0-rc.4/drizzle-orm/src/effect-d1/driver.ts), [SQLite Effect database](https://github.com/drizzle-team/drizzle-orm/blob/v1.0.0-rc.4/drizzle-orm/src/sqlite-core/effect/db.ts)

RC.4's peer range accepts `effect` and the Effect SQL drivers from `4.0.0-beta.83` (or stable v4), including usine's `4.0.0-rc.111` pin. Runtime tests found two incompatibilities:

- RC.4 calls the removed `Schema.TaggedErrorClass` API.
- Its custom yieldable query wrapper doesn't reliably sequence the last mutation before an Effect Workflow suspends.

usine patches the package (`TaggedErrorClass` → `TaggedError`) and uses `yield* query.execute()`, which returns a native Effect and sequenced safely inside a durable workflow in tests against Effect RC.111. Effect v4 requires all Effect packages on one exact version. [RC.4 package metadata](https://github.com/drizzle-team/drizzle-orm/blob/v1.0.0-rc.4/drizzle-orm/package.json), [RC.4 error source](https://github.com/drizzle-team/drizzle-orm/blob/v1.0.0-rc.4/drizzle-orm/src/effect-core/errors.ts), [Effect v4 package versioning](https://github.com/Effect-TS/effect/blob/main/MIGRATION.md#versioning)

## RC.4 API to use

For local Node SQLite:

```ts
import * as SQLiteNodeDrizzle from "drizzle-orm/effect-sqlite-node";

const program = Effect.gen(function* () {
  const db = yield* SQLiteNodeDrizzle.makeWithDefaults({ relations });
  const rows = yield* db.select().from(runs);

  yield* db.transaction((tx) =>
    Effect.gen(function* () {
      yield* tx.insert(events).values(event);
      yield* tx.insert(runs).values(run);
    }),
  );
});
```

`makeWithDefaults` supplies a no-op logger and cache; `make` requires `EffectLogger` and `EffectCache`. Both require the Effect SQL client. Transactions take a callback that returns an `Effect`, not an async callback. [Node driver](https://github.com/drizzle-team/drizzle-orm/blob/v1.0.0-rc.4/drizzle-orm/src/effect-sqlite-node/driver.ts), [Effect query and transaction API](https://github.com/drizzle-team/drizzle-orm/blob/v1.0.0-rc.4/drizzle-orm/src/sqlite-core/effect/db.ts), [Node session](https://github.com/drizzle-team/drizzle-orm/blob/v1.0.0-rc.4/drizzle-orm/src/effect-sqlite-node/session.ts)

For D1:

```ts
import * as D1Drizzle from "drizzle-orm/effect-d1";

const program = Effect.gen(function* () {
  const db = yield* D1Drizzle.makeWithDefaults({ relations });
});
```

D1 has no `jit` option, so shared code must not depend on JIT mapping. Both drivers have the same select/insert/update/delete/transaction shape, but D1 transactions fail in RC.4: the D1 session marks them “Currently throws,” and Drizzle's D1 tests skip them because Effect's D1 client doesn't expose batch. usine's run store needs multi-statement atomicity, so D1 is a target, not a supported adapter, in this release. [D1 driver](https://github.com/drizzle-team/drizzle-orm/blob/v1.0.0-rc.4/drizzle-orm/src/effect-d1/driver.ts), [D1 session](https://github.com/drizzle-team/drizzle-orm/blob/v1.0.0-rc.4/drizzle-orm/src/effect-d1/session.ts), [D1 test exclusions](https://github.com/drizzle-team/drizzle-orm/blob/v1.0.0-rc.4/integration-tests/tests/sqlite/effect-d1.test.ts)

## Schema syntax that differs from 0.x

- Use entity-level casing, for example `snakeCase.table("usine_runs", { runId: text() })`; `drizzle({ casing: ... })` is gone. Column names are optional and derive from the property name. [v0 to v1 changes](https://orm.drizzle.team/docs/v0-v1-changes), [SQLite column types](https://orm.drizzle.team/docs/sqlite/column-types)
- RC.4 removes Relational Query Builder v1 and `db._query` from SQLite. For relational queries, define them with `defineRelations(schema, callback)` and pass `{ relations }` to `makeWithDefaults`; typed CRUD doesn't need them. [RC.4 release](https://github.com/drizzle-team/drizzle-orm/releases/tag/v1.0.0-rc.4), [RQB v1 to v2 guide](https://orm.drizzle.team/docs/relations-v1-v2)
- `getColumns` replaces `getTableColumns`, and `.prepare()` no longer requires a name. Each migration is a directory with `migration.sql` and its snapshot; the shared journal is gone. [v0 to v1 changes](https://orm.drizzle.team/docs/v0-v1-changes)
- `$type<T>()` changes only the TypeScript type, and SQLite `text({ enum: [...] })` doesn't validate at runtime. `text({ mode: "json" }).$type<T>()` adds JSON serialization and a static type, not validation of `T`. Decode states, outcomes, and event payloads with Effect Schema at the database/domain boundary. [SQLite column types](https://orm.drizzle.team/docs/sqlite/column-types)
- Don't copy the PostgreSQL `codec` examples into a SQLite schema. Driver codecs are a new v1 normalization layer, but SQLite `customType` uses `toDriver`, `fromDriver`, `fromJson`, and `forJsonSelect`, and its RC.4 type rejects the `codec` selector. Keep these transforms total, and leave fallible validation to Effect Schema so mapping failures stay typed. [Codec guide](https://orm.drizzle.team/docs/codecs), [RC.4 SQLite custom type source](https://github.com/drizzle-team/drizzle-orm/blob/v1.0.0-rc.4/drizzle-orm/src/sqlite-core/columns/custom.ts)

A suitable table shape:

```ts
import { sql } from "drizzle-orm";
import { check, snakeCase, text } from "drizzle-orm/sqlite-core";

export const runs = snakeCase.table(
  "usine_runs",
  {
    runId: text().$type<Run.RunId>().primaryKey(),
    eventId: text().$type<Event.EventId>().notNull().unique(),
    state: text({ mode: "json" }).$type<Schema.Json>().notNull(),
  },
  (table) => [check("usine_runs_state_json", sql`json_valid(${table.state})`)],
);
```

Store structured JSON as `Schema.Json` (`unknown` for a column with legacy data) and decode it with a named Effect Schema decoder. Brand IDs with `$type` only after a validated boundary checks them.

## Migrations

The TypeScript SQLite schema is the source of truth. `drizzle-kit generate` produces reviewable SQL and snapshots, with SQLite migration-branch conflict detection and multi-parent merges since RC.2. [generate](https://orm.drizzle.team/docs/drizzle-kit-generate), [RC.2 release](https://github.com/drizzle-team/drizzle-orm/releases/tag/v1.0.0-rc.2)

On Node, `drizzle-orm/effect-sqlite-node/migrator` runs them as an Effect and accepts `migrationsFolder` and `migrationsTable`, so usine can keep a `usine_migrations` ledger beside Effect Cluster's `cluster_migrations`. [Node Effect migrator](https://github.com/drizzle-team/drizzle-orm/blob/v1.0.0-rc.4/drizzle-orm/src/effect-sqlite-node/migrator.ts), [migration configuration](https://github.com/drizzle-team/drizzle-orm/blob/v1.0.0-rc.4/drizzle-orm/src/migrator.ts)

RC.4 has no Effect D1 migrator. On D1, apply the same SQL with Drizzle Kit's D1 HTTP support or Wrangler; Cloudflare supports the nested `migrations/*/migration.sql` layout through `migrations_pattern`. Use a D1-specific ledger and one migration runner per database: Drizzle's and Wrangler's ledgers have different formats and must not share a table name. [Drizzle Kit D1 HTTP](https://orm.drizzle.team/docs/guides/d1-http-with-drizzle-kit), [Cloudflare nested migration layouts](https://developers.cloudflare.com/d1/reference/migrations/)

## Portability boundary

Drizzle makes the projection store portable across SQLite drivers, not the whole runtime. Keep these concerns separate:

1. Put tables, indexes, checks, and generated SQL in one driver-neutral SQLite schema package.
2. Keep store operations behind `RunStore`, using only `sqlite-core` features that Node and D1 share.
3. Supply Node SQLite through one composition layer behind a driver-neutral database-layer constructor. Add D1 only when its adapter preserves multi-statement atomic operations. Don't branch product queries on the backend.
4. Keep Effect Cluster on the same `@effect/sql` client, so cluster and usine tables stay in one database.
5. Move filesystem directory creation and startup migration policy out of the engine layer; they are deployment concerns, not `RunStore` ones.
6. Run the same store contract tests against each supported driver. D1 runs SQLite's engine with JSON functions; resolve its transaction gap and its statement, parameter, row-size, and per-invocation limits first. [D1 SQL compatibility](https://developers.cloudflare.com/d1/sql-api/sql-statements/), [D1 limits](https://developers.cloudflare.com/d1/platform/limits/)

The seam is the store service, not a lowest-common-denominator SQL wrapper: Drizzle builds schemas and queries, and application code keeps typed errors and invariants.

## Changelog summary

- RC.1: adds Effect v4 support for PostgreSQL, the new codec machinery, and table-level casing; removes PostgreSQL RQB v1. [RC.1](https://github.com/drizzle-team/drizzle-orm/releases/tag/v1.0.0-rc.1)
- RC.2: adjusts custom codec selection and PostgreSQL transactions, removes prepared-query typings, and adds SQLite migration conflict detection and tree merging. [RC.2](https://github.com/drizzle-team/drizzle-orm/releases/tag/v1.0.0-rc.2)
- RC.3: ports the session/RQB changes to MySQL and removes MySQL RQB v1. [RC.3](https://github.com/drizzle-team/drizzle-orm/releases/tag/v1.0.0-rc.3)
- RC.4: ports the session redesign to SQLite, removes SQLite RQB v1, enables optimized SQLite mappers, and splits SQLite into async and Effect implementations. Fixes codec propagation defects that affect custom mapped columns. [RC.4](https://github.com/drizzle-team/drizzle-orm/releases/tag/v1.0.0-rc.4)

## Recommendation for usine

Pin `drizzle-orm` and `drizzle-kit` at exactly `1.0.0-rc.4`. Replace hand-written usine DDL and row aliases with a shared `sqlite-core` schema and Effect-native queries, and run the generated migrations at Node startup with the Effect SQLite migrator. Keep the compatibility patch and explicit `.execute()` calls until a later Drizzle release passes verification against usine's Effect pin.

This revises ADR 0010's statement that usine tables migrate through the Effect SQL migrator and keeps its one-database and SQLite-first decisions. A supported D1 backend would also revise its statement that local SQLite is v1's only backend; record that in a superseding ADR.
