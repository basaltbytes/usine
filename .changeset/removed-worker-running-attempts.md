---
"@usine/engine": patch
"@usine/orchestrator": patch
"@usine/server": patch
---

While a worker that a reload removed still runs attempts, its **Worker not configured** entry in **Needs attention** shows how many and offers **Discard leftovers** only after they end. Adds `UnconfiguredWorkerNeed.running` and `RunReader.attemptsByWorker` (`WorkerAttempts.running`).

`RunEngine.discardLeftovers` and `Operator.discardLeftovers` fail with `LeftoversDiscardRejectedError` for a worker that is declared or still runs attempts, and `POST /api/workers/:worker/discard-leftovers` returns 409 with it instead of `{ ok: true }`.
