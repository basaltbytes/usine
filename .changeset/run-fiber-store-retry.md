---
"@usine/engine": minor
---

A run whose fiber hits a store failure no longer waits for the next restart. The fiber retries a failed store operation four times with exponential backoff from 100 ms, and the engine reconciles every `ReconcileInterval` (three minutes by default, from `@usine/engine/engine`), starting a fiber for every open run that has none, except runs waiting for approval.
