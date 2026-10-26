---
"@usine/engine": minor
"@usine/executor": minor
"@usine/orchestrator": patch
---

**Discard leftovers** removes the Codex homes of the discarded attempts from an SSH worker that `usine.yaml` no longer declares. `StepExecutor` has a new required member, `discard(worker, attempts)`, which `RunEngine.discardLeftovers` runs after it stops tracking the attempts, and which never fails. The checkouts stay for the operator to remove.

The SSH executor records how to reach each long-lived worker's machine when it adds the worker, in the new `SshExecutorOptions.workerRecordsDirectory`: its destination, port, identity file, and root, without secrets. `sshWorkerRecordsFor(directory)` from `@usine/executor/ssh` returns `discard`, which reads that record and removes `<root>/workers/<name>/codex/<attempt>` for each attempt over SSH. Without a record, or if the machine can't be reached, it logs that and removes nothing. The orchestrator records SSH workers in `.usine/ssh-workers/` in the instance directory and passes that `discard` to `StepExecutor` with every executor kind, so a discard still works after `usine.yaml` replaces the SSH workers with workers of another kind.
