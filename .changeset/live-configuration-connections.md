---
"@usine/server": patch
"@usine/orchestrator": patch
---

Apply webhook mode and URL changes and add Cloudflare workers without restarting the orchestrator. New Cloudflare workers resolve credentials and register a client before preflight; existing clients remain unchanged. Document why tracing and existing worker connection fields require a restart.
