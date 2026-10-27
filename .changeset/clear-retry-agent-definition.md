---
"@usine/engine": patch
"@usine/orchestrator": patch
"@usine/server": patch
---

Show the saved harness and model used by Retry and flag agent definition changes in run details. Edit and retry uses the current loaded definition, including when the task and agent name stay the same. Reject cancellation of failed and succeeded runs with a clear error while preserving repeated cancellation of canceled runs.
