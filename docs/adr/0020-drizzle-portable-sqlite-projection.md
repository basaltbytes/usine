# Drizzle owns the portable SQLite projection

Drizzle ORM's SQLite schema and Effect-native query API own usine's runtime projection tables, queries, and generated migrations. The engine accepts a database layer that provides both a driver-neutral Drizzle database and the matching Effect `SqlClient`; this keeps usine and Effect Cluster state co-located while allowing deployment-specific SQLite drivers. The supplied adapter remains local Node SQLite at `.usine/runtime.sqlite`.

This revises [ADR 0010](./0010-single-sqlite-runtime-store.md). Usine migrations now come from the shared `sqlite-core` schema and run locally through Drizzle's Effect SQLite migrator, not Effect's generic SQL migrator. The one-folder move and backup guarantee applies to the local adapter; a remote adapter owns its own backup procedure.

## Considered Options

- **Keep hand-written SQL and Effect Schema row aliases** — avoids a prerelease ORM, but duplicates column names across DDL, migrations, queries, and decoders. It also leaves each new driver to rebuild the same schema integration.
- **Expose a lowest-common-denominator SQL wrapper** — hides driver types, but adds an API that mirrors Drizzle without owning a domain concept. `RunStore` remains the application boundary; the database layer is a composition boundary.
- **Ship Cloudflare D1 now** — RC.4 includes an Effect D1 driver, but its transaction path currently throws and it has no Effect D1 runtime migrator. The run store depends on atomic multi-statement operations, so an adapter that cannot preserve them is not supported.

## Consequences

- `drizzle-orm` and `drizzle-kit` are pinned to `1.0.0-rc.4`. Generated migration directories, SQL, and snapshots are committed and reviewed with schema changes.
- Effect Schema still validates JSON states, outcomes, payloads, dates, and branded identifiers at the database boundary. Drizzle's `$type` and text enums are static hints, not runtime validation.
- Each supported driver must provide atomic transactions, the SQLite JSON functions used by the store, a migration policy, the same `SqlClient` instance for Effect Cluster, and passage of the run-store contract tests.
- RC.4's published Effect peer range is wider than its runtime compatibility. Until a later release is verified, usine carries a narrow patch from the removed `Schema.TaggedErrorClass` name to `Schema.TaggedError` and executes query builders through their explicit `.execute()` Effect.
- D1 remains an adapter target. Its deployment would apply the generated migration tree through Drizzle Kit or Wrangler with a deployment-owned migration ledger; it must not reuse the local `usine_migrations` table format.
