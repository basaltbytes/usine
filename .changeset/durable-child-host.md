---
"@usine/durable": minor
---

`AttemptRequest` and `StoredRequest` carry the Attempt's child host, and the `subagent` tool gives it to every child, so the Worker decides where children run while the parent stays in the orchestrator. Requests stored before child hosts existed read as `LocalProcess`. `@usine/durable/testing` adds `stubAttemptRuntime`, `StubStorage`, `StubParent`, `completes`, and `worksFor`: an in-memory `AttemptRuntime` for executor and engine tests.
