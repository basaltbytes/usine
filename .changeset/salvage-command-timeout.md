---
"@usine/durable": patch
"@usine/executor": patch
---

A salvage git command that doesn't finish within the 10-minute command timeout no longer crashes the release of a failed attempt's checkout. Before, the salvage read the message of the timeout's cause, which has none, and threw "Cannot read properties of undefined (reading 'trim')". The run then failed with "Step executor defect; operator intervention required" instead of the attempt's own failure, and the checkout and its provisioned machine stayed on the worker without a recorded salvage (#602). Now the run fails with the attempt's own failure, and the salvage records `Retained` with the worktree's path, so the checkout stays on the worker as it does after any other failed git command.

A worker command that exceeds the timeout now fails with the message `<command> didn't finish within 10 minutes`, instead of `Can't run <command>`, which also named a command that couldn't start.

`@usine/durable/testing` adds `StubChild.crash`, which ends a stub child without a result, as a Claude child whose output stream fails, so the parent's `subagent` call fails with a `stream` `SessionOperationError`.
