---
"@usine/orchestrator": minor
"@usine/server": minor
---

Adds `GET /api/configuration`, which returns the parsed instance folder with its runtime state: loops, agents, workers, gateway settings (the admin token's variable name only), repositories, settings, and quarantined loops and invalid agents with their errors. It also responds in setup mode.

`@usine/orchestrator/operator` exports `OperatorConfiguration` and `ConfigurationView`, and `stepExecutorLayer` provides `WorkerStatus` from `@usine/orchestrator/worker-status`. The web UI adds a Configuration section with read-only pages for loops, agents, workers, repositories, and settings, each with a **Reload configuration** button.
