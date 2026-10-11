---
"@usine/durable": minor
---

`AttemptRequest` carries the Attempt's child host, and the `subagent` tool gives it to every child, so the Worker decides where children run while the parent stays in the orchestrator. Like the environment, the child host comes with each `execute` call and is never stored. `@usine/durable/testing` adds `stubAttemptRuntime`, `StubStorage`, `StubParent`, `completes`, and `worksFor`: an in-memory `AttemptRuntime` for executor and engine tests.
