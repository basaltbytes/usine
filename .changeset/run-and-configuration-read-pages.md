---
"@usine/github": minor
"@usine/orchestrator": minor
"@usine/server": minor
---

Run detail, the configuration, the desk, and pull request files fit in one MCP tool result by default. `GET /api/runs/:runId` returns the run's brief: its attempts with their outcomes and failures, the first 1,500 characters of its task prompt, result message, and newest report, and its duration and usage, without the event payload or the transcript. `X-Usine-View: full` returns the run detail with its transcript, and the transcript cursors of `GET /api/runs/:runId` need that header.

`GET /api/runs/:runId/transcript`, the `runTranscript` tool, returns an attempt's transcript newest entry first, in pages that end before 20 KB of JSON and can end inside a long entry. `GET /api/runs/:runId/text/:part`, the `runText` tool, returns the task prompt, the result message, an attempt's report, or the event payload in pages.

`GET /api/configuration` returns a summary of the configuration entities without prompts, personas, lanes, or preflight results, and `X-Usine-View: full` returns the configuration editor's view. `GET /api/desk` returns the running attempts, stalled items, and recent runs that fit 20 KB of JSON, and `omitted` counts the rest. A pull request files read returns the files from `offset` that fit 20 KB of JSON, with `total` and `nextOffset`, and cuts a single patch that is larger than a page. `X-Usine-View: full` returns every desk entry and every file. A page of configuration revisions ends before 20 KB of JSON.
