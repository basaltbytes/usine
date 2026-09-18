---
"@usine/executor": patch
---

List local Worker checkouts once during startup reconciliation so historical Attempts with no checkout require no per-Attempt filesystem checks. Cache listing failures until restart while allowing other Workers to reconcile. Preserve salvage recording before checkout removal and retry retained work on subsequent starts.
