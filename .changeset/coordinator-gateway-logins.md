---
"@usine/agents": patch
"@usine/durable": minor
"@usine/executor": minor
"@usine/orchestrator": patch
"@usine/server": patch
---

Route coordinator model requests through the instance's first configured gateway with a caller token. The orchestrator host needs no provider login when a gateway is configured. Check coordinator gateway credentials at startup and keep usage in the API-key or ChatGPT plan pool. Expose the gateway model route for orchestrator-hosted runtimes.
