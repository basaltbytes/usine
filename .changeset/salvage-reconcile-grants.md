---
"@usine/executor": patch
"@usine/orchestrator": patch
"@usine/web": patch
---

Retry a failed exe.dev credential grant renewal every minute until it succeeds, instead of waiting for the next half-life, and size the grant window independently of `max_attempt_minutes`. Show the last salvage failure in the run drawer for a retained worktree, which every startup retries until its push succeeds.
