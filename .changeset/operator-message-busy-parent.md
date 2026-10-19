---
"@usine/core": minor
"@usine/durable": minor
"@usine/executor": patch
"@usine/server": patch
---

`InterventionState` in `@usine/core/attempt/channel` has `queued`: the session accepted the operator input but reads it only when its current tool call returns. A second receipt for the same input sequence reports the delivery, or an `InterventionRejected` when the session stopped first. Receipts recorded before this change read as not queued.

An operator message to the Pi parent places a Hold, as on a child (ADR 0018, amendment of 2026-10-19). A message to a parent that waits on a child is queued until the child returns. After the parent answers, it waits for the operator instead of ending the Attempt: another message starts its next turn, and `Release` lets it continue the task. A steer places no Hold. Pausing the parent withdraws a queued message, and its second receipt says it was not delivered.

`AttemptReport` in `@usine/durable/attempt-runtime` has `answeredOperator`, true when the parent's last turn replied to operator input and delegated nothing after it, and `harvestedResult` builds the Attempt's `StepResult` from a report and the harvested facts. The executor fails an Attempt whose parent ended on its answer to the operator with an `AgentFailure` when the checkout holds no commit, pull request, or comment, so the Run no longer records `Succeeded`. A stub parent from `@usine/durable/testing` can return a whole `AttemptReport`. The runaway guard's wall-clock ceiling pauses while the parent is held, as it does for a held child.

The Run page and the Run drawer show an operator message the parent has not read yet as "Queued until the parent's current delegation returns". The Run page's composer shows Release parent while the parent is held or paused.
