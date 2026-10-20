---
"@usine/orchestrator": minor
"@usine/server": patch
---

`BoardTaskView` in `@usine/orchestrator/operator` carries `updatedAt`, when GitHub last updated the Task's current Item as the poll stored it, and `pullRequest`, a `BoardPullRequestView` with the number, URL, and state of the Task's open pull request or, without one, its newest merged pull request, or null when it has neither. Code that constructs `BoardTaskView` passes both.

The web UI adds a Tasks list per Project at `/projects/<owner>/<name>/tasks`. It shows the Board's Tasks as rows, the most recently active first: each Task's current Item, state, and lane, the Loops that ran on it, its Run count, its last Run with the stall reason, and its open or merged pull request. A row opens the Task page. Open Tasks show by default, and **Done** adds the Tasks whose current Item is closed or merged, kept in the address as `?done=1`. The sidebar shows **Board** and **Tasks** under each Project, and the Task page's breadcrumb reads `repository › Tasks › #305`. A Board card's stall note names a paused Loop once.
