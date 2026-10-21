---
"@usine/engine": patch
---

The engine reconciles the checkout of an open Attempt that a restart kept for its reattachment as soon as the Run closes the Attempt without reattaching it, instead of at the next startup.

At startup the engine passes each open Attempt whose parent task `StepExecutor.isLive` reports live, or whose liveness cannot be read, to its Run instead of to `StepExecutor.recover`. When the Run's fiber then finds that the parent task stopped or failed, or cannot read whether it is live, it stops the parent task through `StepExecutor.interrupt`, then calls `StepExecutor.recover` on the open Attempt before it closes it. The salvage is recorded before the next Attempt starts, and that Attempt resumes from it. For a parent task that failed, the comments the Attempt posted are recorded too. When `interrupt` fails because the parent task cannot be confirmed stopped, the checkout stays and the Run's fiber stops before its next Attempt, logging `Could not confirm that the parent task of an Attempt its Run does not reattach stopped` at warning; the next reconcile drives the Run again. Canceling a Run whose Attempt waits for its reattachment calls `StepExecutor.recover` on the canceled Attempt, which records its salvage and removes the checkout. Each such reconcile logs `Reconciling the checkout startup kept for an Attempt that was not reattached` at info.
