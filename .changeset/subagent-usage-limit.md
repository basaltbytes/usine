---
"@usine/core": minor
"@usine/agents": minor
"@usine/durable": minor
"@usine/server": patch
---

Wait for a Claude usage limit to reset instead of ending the run as blocked. A Claude Code turn that ends on a usage limit (`rate_limit` or HTTP 429) or another capacity refusal now fails the session with `AgentCapacityError` instead of returning the error text as its answer. The attempt fails with `ProviderCapacityFailure`, whose retry starts no earlier than the reset time from Claude's last rejected rate-limit report. A child's capacity report replaces the Pi parent's own blocker, question, or failure report.

`ProviderCapacityFailure` and `AgentCapacityError` have an optional `resetsAt` field, and `pendingProviderRetry` waits for it. The durable testing stub has a `limit` method that ends a child with a usage limit.
