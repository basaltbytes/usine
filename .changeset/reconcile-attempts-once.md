---
"@usine/engine": patch
---

Startup reconciliation calls `StepExecutor.recover` once per persisted Attempt, however many services the engine layer is provided to. It ran once per service before, so `usine up` reconciled every Attempt four times and logged each of its lines four times.
