---
"@usine/engine": patch
---

The engine reconciles a checkout that a restart kept for reattachment as soon as the run closes the attempt without reattaching it, instead of at the next startup. The salvage is recorded before the next attempt starts from it; if `StepExecutor.interrupt` can't confirm that the parent task stopped, the checkout stays and the run waits for the next reconcile.
