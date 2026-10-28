# Drizzle defines the portable SQLite projection

Drizzle ORM's SQLite schema and Effect-native query API define usine's runtime projection tables, queries, and generated migrations. The engine takes a database layer with a driver-neutral Drizzle database and the matching Effect `SqlClient`, keeping usine and Effect Cluster state together and drivers swappable per deployment. The supplied adapter is local Node SQLite, `.usine/runtime.sqlite`.

This revises [ADR 0010](./0010-single-sqlite-runtime-store.md): migrations come from the shared `sqlite-core` schema and run through Drizzle's Effect SQLite migrator, not Effect's generic one; the one-folder backup guarantee covers only the local adapter.

## Considered options

- **Hand-written SQL with Effect Schema row aliases**: no prerelease ORM, but column names repeat across DDL, migrations, queries, and decoders, and every driver repeats the schema work.
- **A lowest-common-denominator SQL wrapper**: hides driver types but mirrors Drizzle without a domain concept. `RunStore` is the application boundary, the database layer only a composition one.
- **Cloudflare D1 now**: unsupported, because RC.4's Effect D1 driver throws on transactions and has no runtime migrator, and the run store needs atomic multi-statement operations.

## Consequences

- `drizzle-orm` and `drizzle-kit` are pinned to `1.0.0-rc.4`. Generated migrations (directories, SQL, snapshots) are committed and reviewed with the schema.
- Effect Schema still validates JSON states, outcomes, payloads, dates, and branded ids at the boundary; Drizzle's `$type` and text enums are only static hints.
- Each supported driver needs atomic transactions, the store's SQLite JSON functions, a migration policy, and the same `SqlClient` for Effect Cluster, plus passing run-store contract tests.
- RC.4's published Effect peer range exceeds what works, so until a later release is verified, usine patches the removed `Schema.TaggedErrorClass` to `Schema.TaggedError` and runs query builders through explicit `.execute()`.
- D1 stays a target: its deployment would apply the generated migrations through Drizzle Kit or Wrangler with its own ledger, not `usine_migrations`.
- Public engine contracts stay platform-free, so a Workers/D1 bundle pulls in no Node builtins. Adapters use separate subpaths (`@usine/engine/local-sqlite` today), and `layerWithDatabase` at `@usine/engine/engine` accepts `RunDatabase` from `@usine/engine/database`, leaving platform `Crypto` to the deployment. `RunStore`'s declared interface is the contract for non-SQLite backends.

## Amendment (2026-10-11, #176): no shared `SqlClient`

With Effect Cluster removed (ADR 0003 amendment of the same date), the database layer provides only `RunDatabase` and shares no `SqlClient`.

## Amendment (2026-10-19, #336): Drizzle `1.0.0-rc.5-5935859` without a patch

Both Drizzle packages are pinned at `1.0.0-rc.5-5935859`, the `rc5` npm tag's build. Its Effect integration calls `Schema.TaggedError`, which `effect` 4.0.0-rc.111 exports, so the patch is gone. A pnpm patch applies only in the workspace, so npm installs of `@usine/engine` got unpatched RC.4 files and couldn't load `@usine/engine/local-sqlite`. `.execute()` stays.

## Amendment (2026-10-27, #494): Drizzle `1.0.0-rc.5` on Effect 4.0.x

Both Drizzle packages are pinned at `1.0.0-rc.5`, the `rc` npm tag, whose peer range is `effect >=4.0.0`. The `1.0.0-rc.5-5935859` build imports `effect/unstable/sql/SqlError`, which Effect 4.0.x removed when SQL moved to `effect/sql`, so its transaction errors were typed `any`. `.execute()` stays.

## Amendment (2026-10-28, #637): configuration migrations

The configuration store takes Effect's `SqlClient`, supplied by the application on the runtime connection. Its Drizzle schema and generated migrations are in `@usine/config`, with the separate `usine_configuration_migrations` ledger. The package embeds generated migration SQL for deployments without a filesystem. Queries use `SqlClient` directly because the available Effect Drizzle SQLite adapters require concrete drivers. Configuration commits use one transaction with optimistic revision checks; this does not alter the engine's migration chain.

## Amendment (2026-10-28, #477): attention acknowledgements

The engine's `AttentionAcknowledgements` service stores operator dismissals in `usine_attention_acknowledgements`, keyed by entry ID and content revision, with operator login and time. This service uses `RunDatabase`, like `BoardMoves`. The existing run store owns lifecycle transitions, cycle budgets own asks, and cursors permit loss; none owns acknowledgements of configuration or polling findings. The separate capability covers all attention kinds without changing those contracts.

The orchestrator defines each revision from the entry's schema-encoded content. Failed-run entry IDs include the attempt ID, so a later failure with identical text appears again. The overview partitions current entries into visible and dismissed lists. Project status and task badges derive from the visible list; run and ask state remain independent. Undo deletes the matching acknowledgement. Database triggers invalidate the overview cache on acknowledgement changes. Dismissal records for causes no longer reported remain in the store, but only current entries appear under Dismissed.

## Amendment (2026-10-28, #646): acknowledgement pruning

Overview refreshes prune acknowledgements whose ID and revision don't match any current entry, including dismissed entries. This replaces the retention rule in the #477 amendment: a cause that disappears during a refresh needs a new dismissal if it returns. Schedule tick times and worker attempt counts remain part of the revision, so each changed entry still requires attention.

The engine deletes obsolete acknowledgements in one statement, passing current keys as one JSON parameter to SQLite's `json_each` to avoid parameter and expression-depth limits. Matching acknowledgements retain their operator and time. Existing deletion triggers invalidate projections only when rows change; repeating pruning against an unchanged list has no effect.

## Amendment (2026-10-28, #666): startup retention

Overview refreshes defer acknowledgement pruning until both polling and schedule triggers have reported a cycle since startup. The pruning decision uses the same reports as the overview projection, including when the projection comes from the cache. An unreported source does not establish that its previous findings have recovered. Setup mode retains acknowledgements while the trigger services are idle. Once both sources report, the #646 pruning rule applies, including when their completed reports contain no failures.
