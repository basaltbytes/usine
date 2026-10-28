---
"@usine/engine": minor
"@usine/orchestrator": minor
"@usine/server": minor
---

Store authored configuration in the runtime database with atomic revisions, validation, and live updates. Import the instance folder once, and add `usine config export`, `import`, `edit`, and `log` for running and stopped instances. Reject stale edits and invalid imports without saving a revision.

Share the runtime database connection between the engine and configuration store.
