---
"@usine/core": minor
"@usine/orchestrator": minor
"@usine/server": minor
---

A supervisor turn can ask to run operator operations that need more than `read`. The turn gets a tool for each of them, except members, tokens, provider logins, setup, and authentication. A call that a standing grant covers runs at once. Any other call runs nothing: usine stores a permission request with the operation, its arguments, its target, and its project, and the tool returns that the request waits for a member. A conversation on a project requests only operations in that project, and role binding writes and configuration reverts make no request.

`POST /api/conversations/:conversation/requests/:request/answer` answers a request with `once`, `always`, or `deny`. An allowed call runs as the member who answered, with that member's access at that moment; `always` also stores a standing grant for the operation in the call's project, except for operator messages, edit-and-retry, and run-again. A grant applies only while its member's access permits the operation. `GET /api/conversations/:conversation` returns each request with its outcome, `GET /api/supervisor/grants` and `DELETE /api/supervisor/grants/:grant` list and revoke grants, and `GET /api/supervisor/actions` lists the calls that ran. When every request of a turn has an answer, usine queues the conversation's next turn with the outcomes.
