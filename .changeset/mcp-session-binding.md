---
"@usine/server": patch
---

When a device token's stored operation ceiling names an operation ID that no longer exists, the first request with that token after a start logs a warning that names the unknown IDs. `GET /api/tokens` returns them as `unknownOperations`, and **Tokens** shows them as unknown.
