---
"@usine/durable": minor
"@usine/server": minor
---

`usine backup <path>` also copies the durable storage, `.usine/durable.sqlite`, beside the runtime database as `<name>.durable<ext>`, with the same online, read-only copy and hard link into place. It copies the durable storage first and removes that copy again if the runtime copy fails. Restore both files together; an Attempt that was running when the backup was taken then reattaches to its parent task.

`@usine/durable/backup` exports `backup` and `DurableStorageBackupError`. `durableStoragePath` is no longer exported from `@usine/durable/live`.
