---
"@usine/core": minor
"@usine/config": minor
"@usine/engine": minor
"@usine/orchestrator": minor
"@usine/agents": patch
"@usine/server": patch
---

Bound issue and pull-request feedback cycles across Runs with `max_cycles` (default three per Loop). Persist Item-level exhaustion Asks, expose explicit resets in the operator UI and HTTP API, and require fresh trigger evaluation after a reset. Upgrade existing Run history and queued Events into the budget.

Use comment reviews and Loop-defined outcome labels for agents sharing a GitHub App identity. Required independent approvals and merging remain operator actions.
