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

## Amendment (2026-11-01, #814): managed upgrade rollback restores both databases

Before stopping the server or replacing its package, the systemd upgrade helper runs the installed version's `usine backup` command into a private `.usine/upgrade/backup.*` directory. This reuses the online SQLite backup APIs and includes committed WAL data. A failed backup aborts the upgrade without stopping the server or changing packages.

If installation or the target's health check fails, the helper stops the service, restores the previous package and both databases, removes the target's WAL and SHM files, and checks the previous version's API. A database absent before the upgrade remains absent after rollback. Copies are staged before replacing either database, and a failed restore prevents restart. Backups remain available for manual recovery. Failed recovery stops the service and records a failure instead of allowing automatic restarts against incompatible data. Each API health check has a deadline of 180 elapsed seconds, including request and retry delays.

Database restoration is required because startup migrations can change stored schemas and values as well as add configuration entity kinds. Ignoring unknown kinds for a release would cover only additive kind changes and could omit configuration required by other records. Restoring the data with the package gives the previous version the storage format it read before the upgrade. This follows the existing backup ordering and restore rules; the two online copies remain separate snapshots.

## Amendment (2026-11-02, #821): managed upgrade backup retention

The independent systemd helper reads `USINE_UPGRADE_BACKUP_DIR` and `USINE_UPGRADE_BACKUP_KEEP` from its service environment, defaulting to the instance's `.usine/upgrade/` directory and three backups. These settings belong to the helper because it runs independently while the server and its configuration services are stopped. The directory must be absolute and dedicated to the instance; the count is an integer from 1 to 999999999.

Before making a snapshot, the helper checks that both the backup and instance filesystems have free space equal to at least twice the combined database and WAL file sizes. The instance filesystem check covers local rollback staging when backups are external. Insufficient space records a failure with the folder to clean, without stopping the server or changing packages. After the target passes its readiness check, the helper removes older `backup.XXXXXXXX` directories by modification time while always preserving the current snapshot. Cleanup failures are logged and do not roll back a healthy upgrade. Failed upgrades and rollbacks preserve all snapshots. Rollback stages copies beside the instance databases before replacing them, including when the backup directory is on another filesystem.

## Amendment (2026-10-11, #176): the cluster tables are removed

A migration drops `usine_workflow_commands` and Effect's `cluster_messages`, `cluster_replies`, and `cluster_migrations` with the Effect workflow (ADR 0003 amendment of the same date), leaving only usine's tables; pi-durable's storage is the second file.

## Amendment (2026-11-04): step outputs

[ADR 0034](./0034-step-outputs.md) adds typed JSON documents written in the attempt's checkout and collected before cleanup. The durable completion stores full documents for restart recovery; the step result stores refs. Gzip bodies use a separate output store and migration ledger in the runtime database. Idempotent body writes precede attempt completion, and reads expose only outputs of succeeded attempts. This extends the result beyond harvested facts without adding large bodies to run reads or requiring the parent model to emit them.


## Amendment (2026-11-05, #893): sealed SQLite transcripts and compact backups

The SQLite adapter stores transcripts of ended attempts as Brotli quality 5 segments in the runtime database. Each segment contains at most 500 stored rows as NDJSON, preserving their global append positions and original envelope JSON. The adapter supplies an asynchronous `TranscriptCodec`; Node compression stays behind `@usine/engine/local-sqlite`. Postgres can use native compression behind the same run-store and reader contracts.

The local SQLite runtime layer starts the maintenance fiber. The SQLite store and reader layers declare `TranscriptCodec` as a requirement, and database compositions provide it explicitly. Attempts with an outcome become eligible one hour after ending; legacy outcomes without an end time use their start time. Compression runs outside transactions. A write transaction verifies the last append position, inserts segments and a seal with direction high-water marks, then deletes the hot rows. A concurrent append postpones sealing until the next pass. One attempt runs per second, with a one-minute pause between passes; a per-attempt failure advances the pass and is logged with the attempt ID and diagnostic. Storage and compression failures retry in a later pass; malformed stored rows remain hot and are skipped until restart.

Seals retain deduplication after deletion. Later envelopes remain hot and merge with segments through snapshot reads. Page and tail reads decompress only overlapping segments until their row limit is met. Session and worker queries combine sealed and hot history; usage and pool-limit projections remain independent. Run evidence retains one read snapshot.

Runtime backups now use `VACUUM INTO`, replacing the runtime backup API in the earlier sections. This copies a consistent snapshot without free pages while the live database reuses freed pages. The adapter syncs the staged file before publication and the destination directory after creating the hard link. Durable storage retains its online backup API, the durable-first ordering, and atomic publication without overwriting an existing path. This avoids a startup `VACUUM` on the live writer. The operator's [production-copy measurements](https://github.com/basaltbytes/usine/issues/893#issuecomment-6651899606) confirmed 13.1% compressed size, no round-trip mismatches, and a compact 138.9 MB copy of an 896.4 MB store.

## Amendment (2026-11-11, #1162): the attempt journal in the runtime database

The event-driven coordinator from [#1150](https://github.com/basaltbytes/usine/issues/1150) keeps its journal in the runtime database, not in `.usine/durable.sqlite`. The `AttemptJournal` port in `@usine/durable/coordinator/journal` has a memory adapter and a SQLite adapter on the application's `SqlClient`. The SQLite adapter owns four tables (`usine_attempt_coordination`, `usine_attempt_events`, `usine_attempt_delegations`, and `usine_attempt_outbox`) and their own `usine_attempt_journal_migrations` ledger, as the configuration store does. Each transition commits the event, its decision, the coordinator state, the delegations it decides, and its reserved envelopes in one `BEGIN IMMEDIATE` transaction, guarded by a revision.

pi-durable storage stays for attempts run by the Pi parent. Once a coordinator attempt runs on the journal, its state shares the runtime database's backup, so one snapshot captures it. A Postgres adapter adds a sibling dialect module and passes the same contract suite.
