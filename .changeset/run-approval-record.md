---
"@usine/core": minor
"@usine/config": minor
"@usine/engine": minor
"@usine/orchestrator": minor
"@usine/server": patch
---

Runs record who approved them, when, and through which channel. `@usine/core/run/approval` adds `ApprovalSource` (the channel, `ui` or `github-ask`, and the approver's login) and `RunApproval`, and `OperatorLogin` moves from `@usine/config/factory` to `@usine/core/operator`. `RunEngine.approve` and `RunStore.approve` take the `ApprovalSource` and record it once, with the approval Event; a repeated approval keeps the first source. A migration adds `channel` and `approver` to `usine_approvals`, and `RunSnapshot` and `RunSummary` carry `approval`. Approvals recorded before this change have no source.

`Operator.approve` takes the loaded instance and approves as the `operator` login in `usine.yaml`, or with no approver when it names none. `RunView` in `@usine/orchestrator/operator` carries `approval`, an `ApprovalView` with the time and the source, null for approvals recorded before sources were, or null itself while the Run has no approval.

On the Run page, the Event entry and the Event in the reader show “Approved by <login> · <time> · from the UI” or “from the GitHub Ask”, and only “Approved” with the time for a Run approved before this change.
