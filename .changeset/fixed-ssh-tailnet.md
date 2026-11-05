---
"@usine/config": minor
"@usine/executor": minor
"@usine/orchestrator": patch
"@usine/server": patch
---

Support gateway credentials over Tailscale on long-lived SSH workers. Set `tailnet.gateway_address` with a gateway; preflight configures gateway access through passwordless sudo, and attempts use direct internet egress.
