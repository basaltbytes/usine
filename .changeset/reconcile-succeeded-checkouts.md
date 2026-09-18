---
"@usine/core": minor
"@usine/engine": patch
"@usine/executor": patch
---

Reconcile the checkout of a succeeded Attempt at startup. When exe.dev cleanup could not confirm the remote run host had stopped, the checkout stayed on the VM and the abandoned-worktree sweep warned about it at every start without anyone removing it. `RunStore.salvageCandidates` now lists every Attempt with a `succeeded` flag on `AttemptRecovery`, and both executors remove a succeeded Attempt's leftover checkout instead of salvaging it: its result was already delivered, so nothing is pushed or recorded and no credential is issued for the removal.
