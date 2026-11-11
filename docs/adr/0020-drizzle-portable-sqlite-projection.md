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

With Effect Cluster removed (ADR 0003), the database layer provides only `RunDatabase` and shares no `SqlClient`.

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

## Amendment (2026-11-02, #847): statement cache span retention

Effect 4.0.6 cache entries retain their completed lookup fibers. The Node SQLite driver's prepared-statement cache therefore retains the parent span of the first query for each statement. Native spans record their completion exit, so a cached statement can retain an entire HTTP response through its request span. The production heap snapshot for #847 confirms this path.

The local adapter wraps `execute`, `executeRaw`, and `executeValues` on the driver's single connection during layer construction, before exposing either SQL client service. Only these driver methods use the prepared-statement cache. Each cached execution uses an external parent span with the same trace ID, span ID, and sampling state, without the parent span object or its annotations. The surrounding SQL and request spans retain their existing relationships and attributes. Transactions, reserved connections, cache capacity, expiry, and backup use the same connection and synchronization.

This adaptation belongs to the Node SQLite boundary. A workspace-only pnpm patch does not apply to plain npm installations of the published packages. The wrapper is included in `@usine/engine/local-sqlite` and requires no install hook. Regression tests force GC while that adapter remains open and advance the test clock across six hours of queries and statement expiry, including CI monitor polling with a persisted open CI wait.

## Amendment (2026-11-03, #896): SQLite and Postgres adapters

SQLite remains the storage backend for self-hosted single-box instances. Postgres is the next backend for hosted instances with multiple tenants. Both adapters are maintained. Requiring a database server for a local instance adds setup without a local benefit; relying on a local SQLite file for hosted tenancy prevents the deployment from using Postgres's connection management and concurrent writers. This revises ADR 0010's SQLite-only scope. This amendment prepares the boundary; it does not enable a Postgres deployment.

The declared domain service interfaces are the adapter contracts: `RunStore`, `RunReader`, item and repository-label projection readers and writers, `CycleBudgets`, `AttentionAcknowledgements`, `CursorStore`, `LoopControl`, and `BoardMoves`. `ConfigurationStore` and the server's `AuthStore` retain their own contracts. Application services receive these ports through Effect layers. `RunDatabase` is a SQLite composition service, not a database abstraction that Postgres must implement. A Postgres composition supplies implementations of the same domain ports and keeps its driver behind a separate package subpath. Public contracts remain platform-free.

Each adapter owns its Drizzle schema and migrations: `sqlite-core` for SQLite and `pg-core` for Postgres. Share domain schemas, codecs, and invariants rather than generating two SQL schemas from one column definition; dialect-specific indexes, JSON types, and transaction semantics require explicit review. Keep existing SQLite migration histories and ledgers unchanged. A Postgres adapter has a separate migration history, with equivalent constraints and read models verified through contract tests. Tenant scoping belongs in that adapter's design and must apply to every port before hosted use.

Engine query expressions with SQLite semantics are concentrated in `database/dialect.ts`. This includes JSON extraction, expansion, construction and aggregation; null-safe comparison; duration arithmetic; numeric truth predicates; migration pragmas; and selecting the row supplying an aggregate maximum. Paths in indexed JSON expressions remain SQL literals so the existing expression indexes match. Values remain bound parameters. Postgres uses `jsonb` and a corresponding dialect module for scalar extraction, set expansion, object construction, and aggregation. It must preserve the domain result types, missing-value behavior, ordering, and nested JSON values. The query modules remain organized by capability; replacing dialect expressions does not make a `sqlite-core` database client a Postgres client.

The adapter test matrix is part of the boundary. Engine port contracts accept a fixture that supplies service layers, isolated storage, reopening, and failure injection. Every engine adapter runs every port contract; memory and SQLite run the configuration and auth contracts, and pi-durable's memory and SQLite adapters run its storage conformance suite. Transactions must roll back partial lifecycle writes, repeated event claims and transcript appends must remain idempotent, and concurrent writers must preserve each port's guarantees. Adapter-specific plan and migration tests supplement these contracts. The Postgres implementation adds a real Postgres container to CI rather than translating SQL in a test fake.

[Persistence adapters](../persistence.md) inventories the stores, SQLite constructs, and test registrations. Parent workflow storage, local instance locking, recovery files, and backups have separate lifecycles; selecting Postgres for runtime records does not migrate or replace them. D1 remains a possible cloud adapter under the transaction constraints recorded above.

## Amendment (2026-11-03, #892): transcript read models

The transcript transaction updates `usine_session_usage` only for a newly inserted outbound token report whose total exceeds the stored report for that attempt and session. It updates `usine_pool_rate_limits` for a newly inserted outbound pool report by global transcript sequence. Each projection copies the selected envelope, receipt time, sequence, and attempt identity. Duplicate delivery changes neither projection. Readers use these tables through the existing transcript and pool-limit contracts; transcript history remains append-only.

Virtual payload, event, and session columns expose envelope fields. An attempt, payload, event, and sequence index supports worker notices and session-state selection. The generated startup migration adds these columns without rebuilding the transcript table, creates the index, backfills both projections with the previous grouping rules, and drops the former pool index after backfill. Session-state selection groups sessions and interventions separately so each branch searches the kind index without requiring SQLite statistics.

## Amendment (2026-11-03, #895): pool warning revisions

Pool usage warnings are an exception to the #477 content revision rule. Their revisions identify the pool, primary or secondary window, reset time, and highest crossed threshold among 80%, 90%, 95%, and 100%. Exact percentages and login metadata remain display fields. Updates within a band preserve the acknowledgement, while a different band or reset time requires another dismissal. Other attention entries retain their schema-encoded content revisions. The acknowledgement store and pruning rules are unchanged.

## Amendment (2026-11-03, #894): standalone reads on a worker

The local adapter supplies the same `SqlClient` and Node `SqliteClient` services to Drizzle, configuration, and authentication. Standalone `SELECT` statements, including `WITH ... SELECT`, execute on a second, read-only `node:sqlite` connection in a worker thread. Statement classification ignores comments, quoted text, and nested CTE bodies; mutating CTE statements use the writer. The worker's read-only database also prevents writes if classification selects an invalid statement.

Writes, pragmas, transactions, and reserved connections retain the original main connection and its synchronization. The routed client shares the writer's transaction service, transaction implementation, commit callbacks, and reactivity. Transaction reads therefore observe uncommitted writes, and savepoint and rollback behavior stay atomic. `ReadSnapshot` from `/database` defines a consistent read scope; its default implementation uses the supplied database transaction. The local adapter reserves the worker connection for a session, starts a read-only transaction, pins its WAL snapshot, and routes each statement in the scope to that connection through the shared transaction service. `RunReader` uses this scope for every multi-statement read, including summaries, board aggregates, detail, and evidence. The session commits on success and rolls back on failure or interruption before releasing the connection. Unrelated worker reads wait until the session closes. Reads inside write transactions reuse the writer to observe its uncommitted state. During worker recovery, read snapshots use a transaction on the writer. Standalone reads observe committed WAL snapshots and can finish while a writer transaction commits. Connection-local reads, including temporary tables, `changes()`, and `last_insert_rowid()`, require a transaction or reserved connection. Maintenance readers and backup continue to open read-only connections without a worker.

The worker protocol validates requests, bindings, and responses with Effect Schema, preserves safe integers and value-array results, and returns SQLite errors through `SqlError`. The worker caches at most 200 prepared statements without request spans. Interrupted readers remove their pending callbacks; SQLite execution may continue on the worker until it completes or the layer closes. Worker failure fails in-flight reads with a typed connection error and immediately routes later reads to the writer. A supervisor logs the cause at Error, retries startup after 1 second, 5 seconds, 30 seconds, and then every 5 minutes, and restores worker routing after a successful `SELECT 1` probe. The probe has a five-second timeout; successful recovery resets the delay. The local layer provides `SqliteReader.state` for the public health response (`worker`, `fallback`, or `respawning`). Reads use the writer while waiting or probing. Scope closure interrupts the supervisor and terminates its current worker before closing the writer. The writer retains the #847 statement-cache span isolation.

The server samples `monitorEventLoopDelay` at 10 ms resolution and logs p99 and maximum delay in milliseconds every minute, resetting the histogram after each report. The monitor and reporting fiber close with the server scope. The [fixture comparison](../performance/sqlite-event-loop/report.md) measures the existing driver, worker reads, and asynchronous alternatives. The worker retains the installed SQLite engine and requires no additional native dependency. Large result cloning and application decoding still use main-thread time; explicit transactions and other main-connection operations can also block it.
