---
"@usine/executor": minor
"@usine/orchestrator": minor
"@usine/server": minor
---

Operator reads return summaries by default, so that each fits in one MCP tool result. `GET /api/overview` and `GET /api/projects/:project` return each lane's card count without its cards, and leave out project runs and labels; `X-Usine-View: full` returns every card, run, and label. A task read returns the task's items, its lane, `runsTotal`, and its newest runs that fit 10 KB, without comments or commit ranges; `X-Usine-View: task` and `X-Usine-View: full` add them. Task runs are `RunSummaryView` in every representation, so a run's task prompt and result text are on run detail only. A page of lane cards or task runs ends before 20 KB of JSON.

`GET /api/projects/:owner/:repository/items/:item`, the `item` tool, returns the body, comments, and reviews of an issue or pull request on the board as polling stored them, in pages.

MCP tool results are cut at 24 KB, and errors at 10 KB, with a note that says how to read the rest.

The supervisor's model relay forwards `POST /v1/messages/count_tokens` for the configured model through the gateway, and `GatewayModelRoute` has `countTokens`. `usine stop`, `usine restart`, and `usine status` read runs from the `shell` representation of the overview.
