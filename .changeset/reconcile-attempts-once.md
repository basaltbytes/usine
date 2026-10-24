---
"@usine/engine": patch
---

Fixes startup reconciliation calling `StepExecutor.recover` once per service that the engine layer is provided to. `usine up` reconciles each attempt once instead of four times.
