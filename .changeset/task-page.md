---
"@usine/orchestrator": minor
"@usine/server": patch
---

Adds `OperatorObservation.task(instance, repository, item)` to `@usine/orchestrator/operator`, which returns the `TaskView` of the task that contains the item: its items, lane, runs, and recorded comments and reviews. It covers the project's 500 newest items, fails with `BoardItemNotFoundError` or `BoardProjectNotFoundError`, and is served at `GET /api/projects/:owner/:repository/tasks/:item`, also in setup mode.

The web UI adds the task page at `/projects/<owner>/<name>/tasks/<number>`, with the task's items, runs, pull requests, and comments and reviews. Clicking a board card opens it.
