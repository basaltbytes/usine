---
"@usine/engine": minor
---

Requires `effect` 4.0.6 instead of 4.0.0-rc.111, and depends on `@effect/platform-node`, `@effect/platform-node-shared`, and `@effect/sql-sqlite-node` 4.0.6 and on `drizzle-orm` 1.0.0-rc.5, whose Effect integration imports `effect/sql` ([#494](https://github.com/basaltbytes/usine/issues/494)).

When `.usine/runtime.sqlite` can't be opened, the layers of `@usine/engine/local-sqlite` fail with `EnginePersistenceError`, such as `open local database`, and `backup` fails with a `RuntimeStoreBackupError` whose `operation` is `open`. Before, they died with SQLite's error.
