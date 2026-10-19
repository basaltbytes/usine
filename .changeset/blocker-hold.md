---
"@usine/core": patch
"@usine/agents": patch
"@usine/durable": patch
"@usine/engine": patch
"@usine/orchestrator": patch
---

An Agent's `[usine:blocked]` report now ends the Attempt with the new `BlockedFailure` instead of `AgentFailure`, and the Loop holds the Item as it does after a `QuestionFailure`: the first Item state after the blocker, usually the Agent's own blocker comment, returns `Held` and opens no Run, so the Loop no longer reopens on its own comment until the cycle budget runs out. Another change to the Item, a sighting that does not match, a retry, or resolving the Run with `RunEngine.resolveFailure` ends the hold; resolving also gives the newest queued Event its turn.

The session reports the marker as the new `AgentBlockedError` from `@usine/agents/runtime`; a harness failure stays `AgentResultError` and `AgentFailure`. A child's blocker that the parent does not relay fails the Attempt with `BlockedFailure`. Needs you shows it as `BlockedFailureView`, exported from `@usine/orchestrator/operator`.
