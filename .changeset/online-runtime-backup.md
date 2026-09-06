---
"@usine/engine": minor
"@usine/server": minor
---

Add `usine backup <path>` and the local SQLite adapter's online backup capability. Backups include all runtime tables and committed WAL data, publish complete files without overwriting existing destinations, and work while the orchestrator runs. Document restoration and verify full Run evidence export from a restored backup.
