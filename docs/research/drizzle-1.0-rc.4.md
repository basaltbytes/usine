# Drizzle ORM 1.0.0-rc.4: Effect SQLite and D1

Research date: 2026-08-25. Sources are limited to Drizzle, Effect, npm, and Cloudflare material.

## Finding

`drizzle-orm@1.0.0-rc.4` is the first numbered RC in this line to ship Drizzle's Effect-native SQLite sessions. The tagged package exposes `drizzle-orm/effect-sqlite-node`, `drizzle-orm/effect-d1`, `drizzle-orm/effect-libsql`, and SQLite variants for Bun, Durable Objects, and Wasm. RC.4 describes the underlying change as splitting SQLite into async and Effect implementations; RC.3 was still the MySQL session port. Pinning the exact RC is warranted because it remains a prerelease and the SQLite session API changed substantially in that release. [RC.4 release](https://github.com/drizzle-team/drizzle-orm/releases/tag/v1.0.0-rc.4), [RC.3 release](https://github.com/drizzle-team/drizzle-orm/releases/tag/v1.0.0-rc.3), [npm package](https://www.npmjs.com/package/drizzle-orm/v/1.0.0-rc.4)

This is direct integration rather than a Promise wrapper. The Node driver consumes `SqliteClient` from `@effect/sql-sqlite-node`; the D1 driver consumes `D1Client` from `@effect/sql-d1`. Both construct the same SQLite Effect database base and expose Effect-yieldable query builders. [Node driver](https://github.com/drizzle-team/drizzle-orm/blob/v1.0.0-rc.4/drizzle-orm/src/effect-sqlite-node/driver.ts), [D1 driver](https://github.com/drizzle-team/drizzle-orm/blob/v1.0.0-rc.4/drizzle-orm/src/effect-d1/driver.ts), [SQLite Effect database](https://github.com/drizzle-team/drizzle-orm/blob/v1.0.0-rc.4/drizzle-orm/src/sqlite-core/effect/db.ts)

RC.4 declares `effect` and each Effect SQL driver compatible from `4.0.0-beta.83` onward (or stable v4), so usine's `4.0.0-rc.111` pin satisfies its published peer range. Runtime verification still found two incompatibilities that the peer range cannot express: RC.4 calls the removed `Schema.TaggedErrorClass` API, and its custom yieldable query wrapper does not reliably sequence the last mutation before an Effect Workflow suspends. Usine therefore carries a narrow `TaggedErrorClass` → `TaggedError` package patch and calls the native Effect returned by `.execute()` explicitly. Keep all Effect packages on usine's one exact version as required by Effect v4. [RC.4 package metadata](https://github.com/drizzle-team/drizzle-orm/blob/v1.0.0-rc.4/drizzle-orm/package.json), [RC.4 error source](https://github.com/drizzle-team/drizzle-orm/blob/v1.0.0-rc.4/drizzle-orm/src/effect-core/errors.ts), [Effect v4 package versioning](https://github.com/Effect-TS/effect/blob/main/MIGRATION.md#versioning)

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

`makeWithDefaults` supplies Drizzle's no-op logger and cache but still requires the matching Effect SQL client. `make` instead requires the caller to provide `EffectLogger`, `EffectCache`, and the SQL client. Query builders are yieldable Effects and also expose `.execute()`, which returns a native Effect. Usine uses `yield* query.execute()` because runtime verification against Effect RC.111 found it to be the safe sequencing form inside a durable workflow. Transactions take a callback returning an `Effect`, not an async callback. [Node driver](https://github.com/drizzle-team/drizzle-orm/blob/v1.0.0-rc.4/drizzle-orm/src/effect-sqlite-node/driver.ts), [Effect query and transaction API](https://github.com/drizzle-team/drizzle-orm/blob/v1.0.0-rc.4/drizzle-orm/src/sqlite-core/effect/db.ts), [Node session](https://github.com/drizzle-team/drizzle-orm/blob/v1.0.0-rc.4/drizzle-orm/src/effect-sqlite-node/session.ts)

The D1 construction is parallel:

```ts
import * as D1Drizzle from "drizzle-orm/effect-d1";

const program = Effect.gen(function* () {
  const db = yield* D1Drizzle.makeWithDefaults({ relations });
});
```

The D1 configuration deliberately omits `jit`; code shared with D1 should not depend on JIT mapping. Both drivers expose the same select/insert/update/delete/transaction shape, but the apparent transaction parity is misleading in RC.4: the D1 session source marks its implementation “Currently throws,” and Drizzle's D1 test suite skips transactions because Effect's D1 client does not expose batch. Usine's run-store operations require multi-statement atomicity, so D1 is an intended adapter target, not a supported adapter in this release. [D1 driver](https://github.com/drizzle-team/drizzle-orm/blob/v1.0.0-rc.4/drizzle-orm/src/effect-d1/driver.ts), [D1 session](https://github.com/drizzle-team/drizzle-orm/blob/v1.0.0-rc.4/drizzle-orm/src/effect-d1/session.ts), [D1 test exclusions](https://github.com/drizzle-team/drizzle-orm/blob/v1.0.0-rc.4/integration-tests/tests/sqlite/effect-d1.test.ts)

## Schema syntax that differs from 0.x

- Use the entity-level casing API, for example `snakeCase.table("usine_runs", { runId: text() })`. The old `drizzle({ casing: ... })` option is gone. Column names may be omitted and are derived from the TypeScript property. [v0 to v1 changes](https://orm.drizzle.team/docs/v0-v1-changes), [SQLite column types](https://orm.drizzle.team/docs/sqlite/column-types)
- Relational Query Builder v1 and `db._query` are removed from SQLite in RC.4. If relational queries become useful, define them once with `defineRelations(schema, callback)` and pass `{ relations }` to `makeWithDefaults`; ordinary typed CRUD does not require relations. [RC.4 release](https://github.com/drizzle-team/drizzle-orm/releases/tag/v1.0.0-rc.4), [RQB v1 to v2 guide](https://orm.drizzle.team/docs/relations-v1-v2)
- `getTableColumns` is replaced by `getColumns`, and `.prepare()` no longer requires a name. The migration layout is now one directory per migration, containing `migration.sql` and its snapshot rather than a shared journal. [v0 to v1 changes](https://orm.drizzle.team/docs/v0-v1-changes)
- `$type<T>()` only changes the TypeScript type. SQLite `text({ enum: [...] })` likewise does not validate values at runtime. `text({ mode: "json" }).$type<T>()` supplies JSON serialization plus a static type, not validation of `T`. Keep Effect Schema decoding at the database/domain boundary for states, outcomes, and event payloads. [SQLite column types](https://orm.drizzle.team/docs/sqlite/column-types)
- Do not copy the new PostgreSQL `codec` examples into a SQLite schema. Driver codecs are a new v1 normalization layer, but SQLite `customType` uses `toDriver`, `fromDriver`, `fromJson`, and `forJsonSelect`; its RC.4 type does not accept the PostgreSQL `codec` selector. Keep these transforms total and reserve fallible domain validation for Effect Schema so mapping failures remain typed. [Codec guide](https://orm.drizzle.team/docs/codecs), [RC.4 SQLite custom type source](https://github.com/drizzle-team/drizzle-orm/blob/v1.0.0-rc.4/drizzle-orm/src/sqlite-core/columns/custom.ts)

A suitable table shape is therefore:

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

The storage type for structured JSON should remain `Schema.Json` (or `unknown` when the column may contain legacy data), followed by a named Effect Schema decoder into the domain type. Branding IDs with `$type` is appropriate after their values have already crossed a validated application boundary.

## Migrations

Use the TypeScript SQLite schema as the source of truth and pin `drizzle-kit@1.0.0-rc.4` alongside the ORM. `drizzle-kit generate` produces reviewable SQL plus snapshots; RC.2 added SQLite migration-branch conflict detection and multi-parent merge handling. [generate](https://orm.drizzle.team/docs/drizzle-kit-generate), [RC.2 release](https://github.com/drizzle-team/drizzle-orm/releases/tag/v1.0.0-rc.2)

For Node, `drizzle-orm/effect-sqlite-node/migrator` runs those files as an Effect and accepts `migrationsFolder` and `migrationsTable`, so usine can retain a separate `usine_migrations` ledger beside Effect Cluster's `cluster_migrations`. [Node Effect migrator](https://github.com/drizzle-team/drizzle-orm/blob/v1.0.0-rc.4/drizzle-orm/src/effect-sqlite-node/migrator.ts), [migration configuration](https://github.com/drizzle-team/drizzle-orm/blob/v1.0.0-rc.4/drizzle-orm/src/migrator.ts)

RC.4 does not export an Effect D1 runtime migrator. Apply the same generated SQL on D1 with Drizzle Kit's D1 HTTP support or Wrangler. Cloudflare now supports Drizzle's nested `migrations/*/migration.sql` layout through `migrations_pattern`. Use a D1-specific migration ledger and exactly one migration runner for each deployed database; Drizzle's runtime ledger and Wrangler's ledger have different formats and must not share a table name. [Drizzle Kit D1 HTTP](https://orm.drizzle.team/docs/guides/d1-http-with-drizzle-kit), [Cloudflare nested migration layouts](https://developers.cloudflare.com/d1/reference/migrations/)

## Portability boundary

Drizzle makes the usine projection store portable across SQLite drivers; it does not by itself make the whole runtime portable. Keep these concerns separate:

1. Put tables, indexes, checks, and generated SQL in one driver-neutral SQLite schema package.
2. Keep store operations behind the existing `RunStore` service and use only `sqlite-core` query features shared by Node and D1.
3. Supply Node SQLite through one composition layer and keep the public database-layer constructor driver-neutral. Add D1 only when its adapter can preserve the store's multi-statement atomic operations; do not make product queries branch on the backend.
4. Keep Effect Cluster on the same selected `@effect/sql` client so cluster and usine tables remain co-located.
5. Move filesystem directory creation and startup migration policy out of the generic engine layer. Those are deployment concerns, not `RunStore` concerns.
6. Require each supported driver to pass the same store contract tests. D1 uses SQLite's engine and supports JSON functions, but its transaction gap and statement, parameter, row-size, and per-invocation limits must be resolved before adding it to that matrix. [D1 SQL compatibility](https://developers.cloudflare.com/d1/sql-api/sql-statements/), [D1 limits](https://developers.cloudflare.com/d1/platform/limits/)

The clean seam is the store service, not a lowest-common-denominator SQL wrapper. This lets Drizzle own schema/query construction while application code keeps typed domain errors and invariants.

## Changelog summary

- RC.1: introduced Effect v4 support for PostgreSQL, the new codec machinery, table-level casing, and removed PostgreSQL RQB v1. [RC.1](https://github.com/drizzle-team/drizzle-orm/releases/tag/v1.0.0-rc.1)
- RC.2: adjusted custom codec selection and PostgreSQL transactions, removed prepared-query typings, and added SQLite migration conflict detection/tree merging. [RC.2](https://github.com/drizzle-team/drizzle-orm/releases/tag/v1.0.0-rc.2)
- RC.3: ported the session/RQB changes to MySQL and removed MySQL RQB v1. [RC.3](https://github.com/drizzle-team/drizzle-orm/releases/tag/v1.0.0-rc.3)
- RC.4: ported the session redesign to SQLite, removed SQLite RQB v1, enabled optimized SQLite mappers, and split SQLite into async and Effect implementations. It also fixed several codec propagation defects, which matters for custom mapped columns. [RC.4](https://github.com/drizzle-team/drizzle-orm/releases/tag/v1.0.0-rc.4)

## Recommendation for usine

Adopt exact `drizzle-orm@1.0.0-rc.4` and `drizzle-kit@1.0.0-rc.4` pins. Replace hand-written usine DDL and row aliases with a shared `sqlite-core` schema and Effect-native Drizzle queries. Keep explicit Effect Schema decoding for persisted stateful domain values. Generate and commit SQL migrations, run them at Node startup with the Effect SQLite migrator, and reserve D1 for an adapter that can provide atomic store operations and applies the same SQL through Drizzle Kit or Wrangler. Keep the compatibility patch and explicit `.execute()` calls until a later Drizzle release is verified against usine's Effect pin.

This revises ADR 0010's statement that usine tables migrate through the Effect SQL migrator. It does not require abandoning the one-database or SQLite-first decisions. Shipping D1 as a supported backend, rather than only preparing the seam, would also revise ADR 0010's statement that local SQLite is v1's only backend and should be recorded in a superseding ADR.
