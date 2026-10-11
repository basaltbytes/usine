---
"@usine/durable": patch
---

`AttemptRuntime.isLive` reads the Attempt's task as well as its record, so an Attempt whose task was canceled is no longer live, even when its relay failed before sending the terminal envelope. An orchestrator start no longer cancels such a task again on every recovery. A task that finished without a relay attached stays live until `execute` relays its terminal envelope.
