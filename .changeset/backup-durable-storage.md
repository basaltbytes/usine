---
"@usine/durable": minor
"@usine/server": minor
---

`usine backup <path>` also copies the durable storage, `.usine/durable.sqlite`, to `<name>.durable<ext>` next to the runtime database copy. Restore both files together; an attempt that was running at backup time then reattaches to its parent task.

`@usine/durable/backup` exports `backup` and `DurableStorageBackupError`, and `@usine/durable/live` no longer exports `durableStoragePath`.
