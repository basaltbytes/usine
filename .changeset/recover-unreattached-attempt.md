---
"@usine/executor": patch
---

`Executor.recover` stops a live parent task and reconciles the checkout of an open attempt that no run reattaches, instead of leaving it. If the parent task can't be confirmed stopped, `recover` and `cancel` fail with a `cancel` `ExecutorOperationError` and leave the checkout in place.
