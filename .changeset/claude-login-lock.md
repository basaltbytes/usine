---
"@usine/agents": minor
"@usine/executor": minor
"@usine/durable": minor
"@usine/orchestrator": minor
"@usine/server": patch
---

Two Attempts that start on one Worker no longer fail their Claude children on the Worker's shared Claude login.

A Claude child that ends its first turn with `Failed to refresh OAuth token: another Claude Code process ...` and spends no tokens starts again after 15 seconds, then 30, then 60. The transcript records only the start that runs, and the parent receives the error only when the last start fails the same way. Each retry is logged at info with the Attempt id.

`@usine/agents/runtime` adds `ClaudeLoginLock`, one lock per Worker that every Claude command able to refresh the Worker's login takes, and `ChildRequest.worker`, the Worker a child runs on. A Claude launch holds the lock until its first messages show that the login works, for one minute at most; `launch` returns when that check ends. `claudeChildLayer` and `claudeChildBackendLayer` require `ClaudeLoginLock`.

`@usine/executor` exports `claudeLoginLockLayer` from its root. The preflight's Claude check holds the Worker's lock until it returns, and the local, exe.dev, and SSH layers require `ClaudeLoginLock`. Provide one `claudeLoginLockLayer` to the executor and to the Attempt runtime.

`@usine/durable/live`'s `layer` requires `ClaudeLoginLock`, and the `subagent` tool passes the Attempt's Worker to each child. Aborting the tool call or canceling the Attempt while a child's launch waits to retry stops the launch before it starts another Claude process. `@usine/orchestrator`'s Worker compositions require `ClaudeLoginLock`, and `runtimeLayer` provides one instance to the Attempt runtime and the executor.
