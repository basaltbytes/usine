---
"@usine/engine": patch
"@usine/server": patch
---

Run standalone SQLite reads on a read-only worker connection so long queries permit transcript appends and HTTP responses to continue. Preserve main-connection transactions and reserved operations, and report p99 and maximum event-loop delay every minute while the server runs.
