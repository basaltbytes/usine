# One SQLite file in the instance folder stores all runtime state

All durable runtime state is in one SQLite database in the instance folder's gitignored `.usine/` directory: the event ledger and payload snapshots, run, step, and attempt rows, transcripts, runtime toggles (pause, intervention marks), polling watermarks, and Effect's cluster tables. SQLite is v1's only backend. One orchestrator process avoids the lock issue ([Effect-TS/effect#6176](https://github.com/Effect-TS/effect/issues/6176)), polling and cron are in-process timers, and Effect's `SingleRunner` polls its own tables (no LISTEN/NOTIFY), so nothing needs Postgres, which can come later behind the `SqlClient` seam. The folder is the whole instance: to move or back it up, copy it with the orchestrator stopped.

## Considered options

- **SQLite and Postgres in v1**: serves managed-database operators sooner, but costs portable-SQL discipline and a doubled test matrix for a single-operator tool. Premature.
- **Postgres only**: one engine, no lock questions, but needing Postgres before first launch breaks zero-config local-first.
- **Separate databases for Effect and usine**: isolates alpha-dependency churn, but splits the instance into two files that must move together. `cluster_*` prefixes in one database isolate enough.
- **Database in an XDG data directory**: keeps the folder pure git, but the instance spans two locations to gather when moving it.

## Consequences

- Run, step, and attempt rows **project** Effect's engine state: engine-seam code writes row transitions wherever it touches the workflow (launch, approval, retry, interrupt, envelope arrival), and a startup sweep polls Effect by deterministic `executionId` to repair crash drift. Effect's envelopes are internal; the UI reads usine's rows.
- Transcripts are append-only rows in the same database, written as envelopes arrive, so live tail and history are one read. Megabytes per attempt is fine for one operator.
- **v1 prunes nothing.** Dedup keys are permanent ([ADR 0002](./0002-run-model-event-run-step-attempt.md)); snapshots, transcripts, and closed runs are kept, and Effect's envelope rows (undocumented alpha internals) are untouched. Retention can follow v1 if a file grows large.
- Pushing the instance repo backs up config, **not** runtime state. Losing the database loses the "never act twice" ledger: restart refires on all matching state. For a full backup, stop the orchestrator and copy the folder; `usine backup <path>` covers only the runtime database.
- usine's tables migrate with the Effect SQL migrator, tracked apart from `cluster_migrations`.

## Online backup and run evidence

`usine backup <path>` opens the runtime database read-only and copies all tables, committed WAL data included, through SQLite's backup API. It writes beside the destination and hard-links the final file, so no path is overwritten; the filesystem must support hard links. To restore, stop the orchestrator, replace the database, remove old WAL and SHM files, and match the instance configuration and engine version.

`usine export-run <runId>` reads a run snapshot and all saved transcript entries through `RunReader.evidence` in one transaction, as that run's JSON evidence; restoring needs a database backup. Neither command prunes data or changes the dedup ledger.

## Amendment (2026-10-08, #176): two SQLite files in the instance directory

The instance directory now has two SQLite files: the runtime database and pi-durable storage (`.usine/durable.sqlite`) with each local attempt's parent task and conversations (ADR 0006 amendment of the same date). They use separate connections, never one transaction. pi-durable controls its format, assumes one writer, and commits through its own connection, so sharing usine's file would add no atomicity.

The projection-plus-sweep pattern therefore stays for usine's rows. An attempt row can say open while its task finished, failed, or still runs: at startup, the engine reads task liveness through the executor and reattaches or fails the attempt, and executor recovery cancels live tasks of closed attempts. A reattached parent's resent envelope is identified by attempt, direction, and channel sequence, and the first stored copy is kept, so the transcript stays contiguous.

Durable storage opens and resumes its tasks before the engine reconciles worktrees and recovers runs, an order the layers enforce: the engine needs the `StepExecutor`, which needs the local executor, which needs the `AttemptRuntime`. To move or back up the instance, copy both files with the orchestrator stopped.

## Amendment (2026-10-12, #183): `usine backup` copies both files

`usine backup <path>` also copies the durable storage (`<name>.durable<ext>`) the same way. The copies aren't one snapshot, so the durable storage goes first: every attempt the newer runtime copy shows open either has its task in the durable copy or fails as interrupted and is retried. Restore both files from the same backup.

## Amendment (2026-10-11, #176): the cluster tables are removed

A migration drops `usine_workflow_commands` and Effect's `cluster_messages`, `cluster_replies`, and `cluster_migrations` with the Effect workflow (ADR 0003 amendment of the same date), leaving only usine's tables; pi-durable's storage is the second file.
