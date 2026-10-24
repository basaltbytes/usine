---
"@usine/durable": patch
"@usine/engine": patch
"@usine/orchestrator": patch
"@usine/server": patch
---

Pins `@effect/platform-node-shared` to the version of `effect` these packages pin. Fixes `ERR_MODULE_NOT_FOUND` from the Node entry points and the `usine` command when a plain install resolved a release that needs a newer `effect`.
