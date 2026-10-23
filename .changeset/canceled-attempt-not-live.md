---
"@usine/durable": patch
---

`AttemptRuntime.isLive` returns false for an attempt whose task was canceled, even if its relay failed before the terminal envelope, so orchestrator startup no longer cancels that task again. A task that finished without an attached relay stays live until `execute` relays its terminal envelope.
