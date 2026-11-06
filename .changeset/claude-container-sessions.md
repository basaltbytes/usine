---
"@usine/agents": patch
"@usine/executor": patch
---

Preserve Claude Code sessions across orchestrator restarts on container-isolated SSH workers. Store projects in an attempt-scoped worker directory until checkout cleanup, and remove orphan session directories during sweeping and provisioned machine resets. Harness descriptors declare container session storage independently of credential wiring.
