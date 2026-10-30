---
"@usine/server": patch
"@usine/orchestrator": patch
"@usine/executor": patch
---

Apply webhook mode and URL changes and add Cloudflare workers without restarting the orchestrator. New Cloudflare workers resolve credentials and register a client before preflight; existing clients remain unchanged. A refused addition releases its client, so a corrected revision can add the worker. Document why tracing and existing worker connection fields require a restart.
