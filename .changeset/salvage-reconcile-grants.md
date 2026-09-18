---
"@usine/executor": patch
"@usine/orchestrator": patch
"@usine/web": patch
---

Retry a failed exe.dev credential grant renewal every minute until it succeeds, instead of waiting for the next half-life, and size the grant window independently of `max_attempt_minutes`. Show the last salvage failure in the run drawer for a retained worktree, which every startup retries until its push succeeds. The recorded failure now carries git's own stderr after the exit code, on the Attempt's salvage and on the startup reconcile alike, and names a stalled push instead of a bare `TimeoutError`.
