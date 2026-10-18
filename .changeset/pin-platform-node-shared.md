---
"@usine/durable": patch
"@usine/engine": patch
"@usine/orchestrator": patch
"@usine/server": patch
---

Depend on `@effect/platform-node-shared` at the version of `effect` these packages pin. `@effect/platform-node` asks for it with a caret range, which npm and pnpm resolved to the latest stable release. That release needs a newer `effect`, so after a plain install the Node entry points, and the `usine` command, failed with `ERR_MODULE_NOT_FOUND`. An install now gets the `@effect/platform-node-shared` that matches its `effect`.
