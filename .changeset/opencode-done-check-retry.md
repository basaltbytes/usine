---
"@usine/agents": patch
"@usine/server": patch
---

An OpenCode child whose execution succeeded no longer fails on one failed read of OpenCode's running jobs, inbox, or active sessions. The runtime logs the failure at Warning and retries it twice, about 1 and then 3 seconds later. If the read still fails, the child fails with a `SessionOperationError` that names the read.

A paused OpenCode child whose late steer OpenCode delivered before it answered the steer's post now ends its turn with the execution that read the steer, not with the paused execution's answer.
