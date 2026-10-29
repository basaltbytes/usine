---
"@usine/core": minor
"@usine/agents": minor
"@usine/durable": patch
"@usine/engine": patch
"@usine/orchestrator": minor
"@usine/server": patch
---

Retry temporary model provider capacity refusals automatically, with a delay and the existing three-attempt cap. Retries resume from salvaged work; the run page shows the provider message and the next attempt time. The retry deadline survives orchestrator restarts and cancellation stops the wait.

Add typed capacity failures, child reports, and provider retry starts. Codex and Claude use structured overload codes where available, while message-only errors recognize capacity refusals, HTTP 529, and HTTP 503 with a retry hint. Other task failures retain their existing behavior.
