---
"@usine/engine": patch
---

Fixes a failed attempt that gave up its worker slot when usine couldn't confirm that its parent task stopped, so another attempt, such as the run's automatic retry, could start in that slot beside the task. Before it closes a failed attempt, the engine now confirms the stop through `StepExecutor.interrupt`. If the stop isn't confirmed, the attempt keeps the slot and is listed in `UnconfirmedStops` and **Needs attention**, as after a cancel, until a reconcile confirms the stop.
