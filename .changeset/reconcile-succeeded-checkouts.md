---
"@usine/core": minor
"@usine/engine": patch
"@usine/executor": patch
---

Startup reconciles the leftover checkout of a succeeded attempt: both executors remove it without salvage or a credential. `RunStore.salvageCandidates` lists every attempt with a `succeeded` flag on `AttemptRecovery`, and the exe.dev executor lists each worker's leftover checkouts once per start.
