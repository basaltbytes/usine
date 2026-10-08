# One SQLite file inside the instance folder is the factory's whole runtime memory

All durable runtime state — the Event ledger and payload snapshots, Run/Step/Attempt rows, attempt transcripts, runtime toggles (pause, intervention marks), polling watermarks, and Effect's own cluster tables — lives in a single SQLite database in a gitignored `.usine/` directory inside the instance repo folder. SQLite is v1's only shipped backend: the single orchestrator process sidesteps the known multi-process lock issue ([Effect-TS/effect#6176](https://github.com/Effect-TS/effect/issues/6176)), nothing in the design needs Postgres-only machinery (polling and cron are in-process timers; Effect's `SingleRunner` polls its own tables, no LISTEN/NOTIFY on any backend), and Postgres stays additive behind the SqlClient seam. The instance folder is therefore the entire factory — authored config committed, runtime state beside it — and moving or backing it up is copying one directory (orchestrator stopped). `usine backup <path>` takes an online copy of the runtime database; authored files and credentials remain separate.

## Considered Options

- **SQLite + Postgres both in v1** — serves cloud/managed-DB operators day one, but costs portable-SQL discipline and a doubled test matrix for a single-operator tool; rejected as premature.
- **Postgres only** — one engine, no lock questions, but a running Postgres before first launch breaks zero-config local-first.
- **Separate databases for Effect and usine** — isolates the alpha dependency's churn, but splits the factory into two files that must move together; prefix separation (`cluster_*` vs usine's tables) in one database gives the isolation that matters.
- **DB in an XDG data dir** — keeps the instance folder pure git, but the factory then spans two locations that must be gathered to move it.

## Consequences

- Run/Step/Attempt rows are a **projection** of Effect's engine state: usine's engine-seam code writes row transitions at every point it touches the workflow (launch, approval, retry, interrupt, envelope arrival), and a startup sweep polls Effect by deterministic executionId to repair crash-window drift. Effect's envelopes are engine-internal; usine's rows are the operator truth the UI reads.
- Attempt transcripts are append-only rows in the same database, written as attempt-channel envelopes arrive — live tail and history are the same read; megabytes per attempt is acceptable at single-operator scale.
- **v1 prunes nothing.** Dedup keys are permanent by decision ([ADR 0002](./0002-run-model-event-run-step-attempt.md)); snapshots, transcripts, and closed-run rows are kept, and Effect's envelope rows are never touched (undocumented alpha internals). Retention machinery is a post-v1 concern if a real factory's file actually gets big.
- Pushing the instance repo to a remote backs up authored config but **not** runtime state. Losing the DB loses the "never act twice" ledger: on restart, cold start refires on all currently-matching state. For a whole-instance backup, stop the orchestrator and copy the instance folder. `usine backup <path>` copies the runtime database online; back up configuration and credentials separately.
- usine's own tables migrate via the Effect SQL migrator, in usine's own migration table — same pattern, separate from `cluster_migrations`.

## Online backup and Run evidence

`usine backup <path>` opens the runtime database read-only and copies all tables, including committed WAL data, through SQLite's backup API. It writes the copy beside the destination, then uses a hard link to create the final file without overwriting an existing path. The destination filesystem must support hard links. Restore with the orchestrator stopped: replace the runtime database, remove old WAL and SHM files, and use the matching instance configuration and engine version.

`usine export-run <runId>` reads a Run snapshot and every saved transcript entry through `RunReader.evidence` in one transaction. The JSON contains the evidence for that Run; use a database backup to restore the factory. Neither command prunes data or changes the deduplication ledger.

## Amendment (2026-10-08, #176): two SQLite files in the instance directory

The instance directory now holds two SQLite files: usine's runtime database, and the pi-durable storage (`.usine/durable.sqlite`) that holds each local Attempt's parent task and conversations (ADR 0006 amendment of the same date). They use separate connections and never share a transaction. pi-durable owns its storage format and assumes one writer per storage, and it commits through its own connection whatever file it uses, so putting it in usine's file would buy no atomicity.

The projection-plus-startup-sweep pattern therefore stays for the rows usine keeps. An Attempt row can say open while its parent task has finished, failed, or is still running; at startup the engine reads the task's liveness through the executor and either reattaches the Attempt or fails it, and executor recovery cancels a live task whose Attempt row is already closed. A transcript envelope that a reattached parent sends again after a restart is identified by its Attempt, direction, and channel sequence, and keeps its first stored copy, so the transcript stays one contiguous sequence.

Startup order matters: the durable storage is opened and its tasks resumed before the engine reconciles worktrees and recovers Runs. The layers enforce it, since the engine needs the `StepExecutor`, which needs the local executor, which needs the `AttemptRuntime`. Moving or backing up the factory now means copying both files with the orchestrator stopped.
