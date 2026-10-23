---
"@usine/durable": minor
---

`AttemptRequest` contains the attempt's child host, which the `subagent` tool passes to every child, so the worker decides where children run. `@usine/durable/testing` adds `stubAttemptRuntime`, `StubStorage`, `StubParent`, `completes`, and `worksFor`, an in-memory `AttemptRuntime` for executor and engine tests.
