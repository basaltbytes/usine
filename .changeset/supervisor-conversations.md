---
"@usine/agents": minor
"@usine/core": minor
"@usine/orchestrator": minor
"@usine/server": minor
---

Members can talk to the supervisor through the operator API. `POST /api/conversations` starts a conversation on the instance or a project, and `POST /api/conversations/:conversation/messages` queues a turn behind the conversation's earlier turns. A turn runs in the supervisor sandbox and is read-only: it has `read` on the conversation's scope within the current access of the token or session that posted the message, and it stores its session events as they arrive; `GET /api/conversations/:conversation/events?after=<sequence>` reads them. `POST /api/conversations/:conversation/turns/:turn/cancel` stops a turn and keeps its events. After a restart, a turn that was running is `failed` with the `Interrupted` failure, and queued turns run. `GET /api/conversations/status` reports `ready` or `setup-required`. Each change emits a `conversation` change notice. The conversation routes are not MCP tools, and a turn can't call them.

`runSupervisorTurn` takes an `observe` callback that receives each session event as it arrives. A turn reads the source of the repositories in its scope that the member can read.
