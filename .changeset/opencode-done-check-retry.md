---
"@usine/agents": patch
"@usine/server": patch
---

An OpenCode child whose execution succeeded no longer fails on one read of OpenCode's running jobs, inbox, or active sessions that gets a server error (HTTP 5xx) or no answer within 60 seconds. The runtime logs the failure at Warning and retries it twice, about 1 and then 3 seconds later. If the read still fails, the child fails with a `SessionOperationError` that names the read. Any other failure of the read, such as a 4xx answer or a body that doesn't decode, fails the child at once with an error that names the read. A read that loses the bridge isn't retried: a remote child reopens its session on a new bridge, and a local child fails with the bridge's own error.

A paused OpenCode child whose late steer OpenCode delivered before it answered the steer's post now ends its turn with the successor execution that the steer starts, not with the paused execution's answer. A late steer that OpenCode delivers while the runtime interrupts the paused execution, before a successor starts, was read by that execution, so the paused execution's answer ends the turn.
