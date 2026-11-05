---
"@usine/agents": minor
"@usine/durable": minor
"@usine/executor": minor
"@usine/orchestrator": patch
---

Route Pi coordinators through their worker’s gateway with an attempt caller token. Gateway attempts no longer require a provider login on the orchestrator host. Preflight checks the coordinator’s provider credential and model proxy, and usage follows the gateway’s API-key or ChatGPT subscription pool.
