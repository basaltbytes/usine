---
"@usine/github": minor
"@usine/orchestrator": patch
---

Polling fetches an open pull request again only when change detection reports it, its base branch head moved or can't be read, or its `mergeable` is `UNKNOWN`, instead of on every poll. Each poll reads each base branch head with one conditional request. `GitHubPolling` adds `baseRefHead`, `@usine/github/polling` exports `BaseRefName` and `BaseRefHead`, and `PullRequestPayload.baseRefName` is a `BaseRefName`.
