---
"@usine/agents": minor
---

Codex serves usine tool sets. `HarnessRuntime.open` on Codex registers the toolkit on `thread/start` as client-served dynamic tools in the namespace `usine`, through the app server's experimental API, which the connection opts into only for a session with usine tools. Codex sends each call as an `item/tool/call` request on the session's connection, and the handler's result answers it; a failed call reaches the model as a tool error. When Codex cancels a call, such as on a turn interrupt, the session interrupts its handler instead of letting it finish unseen. A resumed thread restores its tools, and the reopened connection serves their calls. `ToolStarted` and `ToolFinished` carry the toolkit's names, and the name `mcp`, which Codex reserves, gets an alias.

The Codex descriptor declares `usine-tools`, which the `host-tool` contract scenario proves on Codex 0.164.0. It still lacks `closed-tools`: its model catalog keeps `apply_patch`, the code-mode `exec` and `wait` tools, and the MCP resource tools on in every thread, so Codex refuses a role that closes native tools.

`CodexClient` adds `serve`, which answers the app server's requests to the client; the connection still refuses every request that `serve` doesn't take. `initializeCodex` takes `{ experimentalApi }`.
