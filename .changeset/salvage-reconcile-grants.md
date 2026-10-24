---
"@usine/executor": patch
"@usine/orchestrator": patch
---

Retries a failed exe.dev credential grant renewal every minute until it succeeds, and sizes the grant window independently of `max_attempt_minutes`. The run drawer shows the last salvage failure of a retained worktree, which every startup retries; the recorded failure includes git's stderr and names a stalled push instead of a bare `TimeoutError`.
