# Runtime state lives in SQLite files in the instance folder

The local instance keeps its runtime state in the gitignored `.usine/` directory, so the folder is the whole instance:

- **The runtime database** (`.usine/runtime.sqlite`) holds the event ledger and payload snapshots, run, step, and attempt rows, transcripts, runtime toggles, polling watermarks, authored configuration (ADR 0031), step outputs (ADR 0034), and the event-driven coordinator's attempt journal. Its migrations run at startup (ADR 0020). One orchestrator process is the only writer.
- **pi-durable storage** (`.usine/durable.sqlite`) holds each Pi parent's task and conversations. pi-durable controls its format and commits through its own connection, so it shares no transaction with the runtime database.

An attempt row can say open while its pi-durable task finished, failed, or still runs. At startup, the engine reads each attempt's liveness through the executor and reattaches or fails it, and executor recovery cancels the live tasks of closed attempts. The attempt journal shares the runtime database's connection: each transition commits its event, decision, state, delegations, and reserved envelopes in one `BEGIN IMMEDIATE` transaction. A resent envelope is identified by attempt, direction, and channel sequence, and the first stored copy is kept, so the transcript stays contiguous.

Dedup keys are permanent (ADR 0002), and closed runs, snapshots, and transcripts are kept. An ended attempt's transcript is sealed into Brotli segments an hour after it ends, keeping its dedup marks.

`usine backup <path>` copies both files while the orchestrator runs: pi-durable storage first, then the runtime database with `VACUUM INTO`. Every attempt that the newer runtime copy shows open has its task in the durable copy, or fails as interrupted and is retried. Restore both files from one backup. A managed upgrade backs up first and, if the target fails its health check, restores both databases with the previous package, since migrations change stored schemas.

Pushing the instance repository backs up configuration, not runtime state.

## Considered options

- **Postgres in v1**: serves managed-database operators sooner, but breaks zero-config local-first and doubles the test matrix. Postgres and D1 come later behind `SqlClient` and the store ports.
- **One file for pi-durable and usine**: a shared file adds no atomicity, because pi-durable assumes one writer and commits through its own connection.
- **Coordinator state in pi-durable storage**: two files to back up together for one attempt.
- **A database in an XDG data directory**: the instance would span two locations.
