---
"@usine/engine": patch
"@usine/orchestrator": patch
"@usine/server": patch
---

Fixes a canceled attempt that gave up its worker slot when usine couldn't confirm that its parent task stopped, so another attempt could start on that worker beside the task. The attempt now keeps its run's slot, also after its execution acquired the checkout and without a restart. Each reconcile retries the stop and frees the slot once the stop succeeds. After a restart, startup still occupies a slot for each closed attempt whose stop it can't confirm.

`RunEngine.cancel` moves the slot of the run's fiber to the attempt before it stops the parent task. `UnconfirmedStops` in `@usine/engine/engine` lists the attempts whose stop the engine retries, and `UnconfirmedStops.empty` lists none; `OperatorObservation` requires it. **Needs attention** shows each attempt as an `UnconfirmedStopNeed`, **\<loop\>: parent task not stopped**.
