---
"@usine/agents": patch
"@usine/durable": patch
---

Depend on `@earendil-works/pi-codemode` 1.1.0 next to `@earendil-works/pi-coding-agent` 1.1.0. pi-coding-agent asks for pi-codemode with a caret range, which a plain install resolved to 1.3.0. That release no longer exports `MCP_TYPESCRIPT_PREAMBLE`, so after a plain install `@usine/durable/live`, the executor and orchestrator entry points that load it, and `usine up` failed with a `SyntaxError`.
