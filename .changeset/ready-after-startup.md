---
"@usine/server": patch
"@usine/orchestrator": patch
---

Add a public `/api/ready` endpoint that returns HTTP 503 during startup recovery and HTTP 200 afterwards. Managed upgrades require both the expected version and readiness before recording success, so a startup failure restores the previous package and both databases. Rollback supports releases that predate the readiness endpoint.
