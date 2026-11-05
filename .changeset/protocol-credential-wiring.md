---
"@usine/core": minor
"@usine/agents": minor
"@usine/config": minor
"@usine/gateway": minor
"@usine/executor": minor
"@usine/cloudflare": patch
"@usine/orchestrator": patch
"@usine/server": patch
---

Read harness credential environment variables and configuration files from descriptors, and manage SSH attempt homes per harness.

Gateway credential slots and URL prefixes use `anthropic-messages` and `openai-responses`. Upgrade the gateway and orchestrator together, replacing `anthropic` and `openai` in `gateway.llm_providers`. Provisioner API-key names, Cloudflare provider records, and gateway credential environment-variable names stay the same.
