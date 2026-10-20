---
"@usine/durable": patch
---

`AttemptRuntime.notify` keeps a Worker notice sent before the Attempt is relayed or before its parent started, and records it right after `Started` instead of dropping it.
