---
"@usine/engine": minor
---

A Run whose fiber hits a store failure no longer waits for the next restart. The fiber repeats a store operation that failed to persist four times with exponential backoff, from 100 ms, before it stops. The engine then reconciles every `ReconcileInterval`, three minutes by default, and starts a fiber for every open Run that has none; provide `ReconcileInterval` from `@usine/engine/engine` to change the interval. A Run waiting for its approval gets no fiber from a reconcile, since its approval starts one.
