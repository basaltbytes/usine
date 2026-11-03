---
"@usine/engine": patch
"@usine/server": patch
---

Run standalone SQLite reads on a read-only worker connection so long queries permit transcript appends and HTTP responses to continue. Preserve main-connection transactions and reserved operations, and report p99 and maximum event-loop delay every minute while the server runs.

Recover from read worker failures by routing later reads to the main connection, restarting the worker with bounded backoff, and reporting its state through `/api/health`.

Read run summaries, their attempts, evidence, and board history aggregates in scoped read-only worker snapshots. Preserve consistent lifecycle states during concurrent completion and retries while transcript appends and HTTP responses continue. Roll back interrupted snapshots; use the main connection during worker recovery and within write transactions.
