---
"@usine/server": patch
---

An MCP session on `POST /api/mcp` answers only the credential that opened it, and ends after one hour without a request or when the caller's tool list changes. A request for a session that ended or belongs to another credential, including `DELETE`, returns HTTP 404, and the client starts a new session.

When a device token's stored operation ceiling names an operation ID that no longer exists, the first request with that token after a start logs a warning that names the unknown IDs. `GET /api/tokens` returns them as `unknownOperations`, and **Tokens** shows them as unknown.
