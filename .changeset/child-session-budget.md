---
"@usine/agents": minor
"@usine/config": minor
"@usine/core": minor
"@usine/engine": minor
"@usine/executor": minor
"@usine/orchestrator": minor
"@usine/run-host": minor
---

Apply `settings.max_children` as a per-Attempt child-session budget. Protocol v4 sends the budget to the Pi parent, records each accepted spawn with its cumulative count and task excerpt, and reports an excess spawn as a typed non-retryable failure with the configured and attempted counts.
