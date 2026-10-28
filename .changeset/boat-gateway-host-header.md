---
"@usine/orchestrator": patch
"@usine/server": patch
---

Fix Boat gateway preflight by using Node's HTTP client for SSH workers. Gateway probes now preserve the `Host` header when connecting to a tailnet address.
