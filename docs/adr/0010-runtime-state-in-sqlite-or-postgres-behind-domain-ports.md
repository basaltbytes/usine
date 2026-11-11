# Runtime state in SQLite or Postgres behind domain ports

usine keeps its runtime state behind domain ports: runs and the event ledger (`RunStore`, `RunReader`), item and label projections, cycle budgets, attention acknowledgements, cursors, loop control, board moves, step outputs (`StepOutputStore`), configuration (`ConfigurationStore`), members and sessions (`AuthStore`), and the coordinator's `AttemptJournal`. Application services receive these ports through Effect layers, so no service depends on a SQL dialect. Each port has a contract suite that every adapter of that port runs.

Two adapters are decided:

- **SQLite** for a self-hosted instance. It is built: every store uses one runtime database, `.usine/runtime.sqlite` in the instance folder, opened by one server process, so a local instance needs no database server.
- **Postgres** for hosted instances with several tenants, because it gives a deployment connection management and concurrent writers that a local file can't. It is decided (#896) and not built.

Each store adapter owns its schema and its migrations under a separate ledger, and keeps its dialect-specific SQL in one module: `packages/engine/src/database/dialect.ts` for the engine, and the store's `sqlite` module elsewhere. JSON functions, indexes, and transaction semantics differ between dialects, so each adapter needs its own review. Drizzle `sqlite-core` schemas generate the engine, configuration, and attempt journal migrations. Rows decode through Effect Schema at the port boundary.

Losing the runtime database loses the dedup ledger, so polling acts again on every matching item. `usine backup` copies the databases while the server runs. A restore needs the engine version that wrote the backup, because startup migrations change stored schemas.

pi-durable keeps each Pi-parent attempt in a second file, `.usine/durable.sqlite`, with its own schema. That file goes with the Pi parent (#1166); the attempt journal that replaces it has a SQLite adapter on the runtime database's connection.

## Considered options

- **SQLite only**: no setup, but hosted tenancy needs concurrent writers.
- **Postgres only**: one dialect, but a database server before the first run.
- **One SQL schema generated for both dialects**: hides the differences that need review.
- **A database in an XDG data directory**: the instance would span two locations.
- **Hand-written SQL for the engine's tables**: column names repeat across DDL, migrations, queries, and decoders.
- **Cloudflare D1**: Effect's D1 client doesn't support transactions, and the run store needs atomic multi-statement writes. D1 stays possible behind the same ports.
