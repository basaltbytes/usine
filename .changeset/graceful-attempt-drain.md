---
"@usine/engine": patch
"@usine/server": patch
---

Drain admitted Attempts on SIGINT or SIGTERM before closing the runtime. Defer queued work and automatic retries until restart, with a bounded shutdown wait and a second-signal force stop.
