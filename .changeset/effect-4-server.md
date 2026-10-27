---
"@usine/server": patch
---

Runs on `effect` 4.0.6 instead of 4.0.0-rc.111 ([#494](https://github.com/basaltbytes/usine/issues/494)). When `usine up` can't open `.usine/runtime.sqlite`, it stops with `runtime store error: could not open local database` and the reason, instead of a defect with SQLite's error.
