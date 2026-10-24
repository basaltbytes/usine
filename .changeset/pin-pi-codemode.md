---
"@usine/agents": patch
"@usine/durable": patch
---

Pins `@earendil-works/pi-codemode` to 1.1.0, next to `@earendil-works/pi-coding-agent` 1.1.0. Fixes a `SyntaxError` in `@usine/durable/live`, the executor and orchestrator entry points that load it, and `usine up` when a plain install resolved pi-codemode 1.3.0, which doesn't export `MCP_TYPESCRIPT_PREAMBLE`.
