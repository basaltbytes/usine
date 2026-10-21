---
"@usine/engine": patch
"@usine/orchestrator": patch
"@usine/server": patch
---

While a Worker a reload removed still runs Attempts, its **Worker not configured** entry in Needs attention says how many, such as "2 attempts still run on it; discard its leftovers once they end", and offers **Discard leftovers** only once they end. `UnconfiguredWorkerNeed` carries that count as `running`, and `RunReader.attemptsByWorker` counts the open Attempts of each Worker in `WorkerAttempts.running`.

`RunEngine.discardLeftovers` and `Operator.discardLeftovers` now fail with `LeftoversDiscardRejectedError`, which names the Worker and counts its open Attempts, for a Worker that is declared or still runs Attempts. `POST /api/workers/:worker/discard-leftovers` answers 409 with that refusal instead of `{ ok: true }`, and Needs attention shows its message.
