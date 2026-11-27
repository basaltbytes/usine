---
"@usine/agents": patch
"@usine/server": patch
---

An OpenCode child whose execution succeeded no longer fails on one failed read of OpenCode's running jobs, inbox, or active sessions. The runtime logs the failure at Warning and retries it twice, about 1 and then 3 seconds later. If the read still fails, the child fails with a `SessionOperationError` that names the read.

A paused OpenCode child whose late steer OpenCode delivered before it answered the steer's post now ends its turn with the successor execution that the steer starts, not with the paused execution's answer. A late steer that OpenCode delivers while the runtime interrupts the paused execution, before a successor starts, was read by that execution, so the paused execution's answer ends the turn.
