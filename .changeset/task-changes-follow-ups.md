---
"@usine/github": minor
"@usine/orchestrator": minor
"@usine/server": minor
---

On the task page, **Retry** after a pull request's base or head changed refreshes the task first and then loads the PR's current changes, instead of repeating the stale selection. When every recorded attempt on a pull request pushed no new commits, the **Changes** panel says so instead of reporting that no attempt commits were recorded. Task detail's `attemptChanges` now includes those attempts with a `base` equal to their `head`.

When GitHub answers 404 for a file read because the GitHub App installation doesn't cover the repository, `GET /api/projects/:project/pull-requests/:repository/:item/files` returns `503` with `ProjectNotInstalledError` and says that the App lost access, instead of reporting an unavailable comparison or force push. `GitHubFiles.read` fails with `ProjectNotInstalledError` in that case.

The server cache for pull request files holds up to 64 MiB of file paths and patch text and evicts the least recently read responses first, so responses over 512 KiB are cached too. Concurrent reads of one selection share their GitHub requests.

`@usine/github/files` exports only `GitHubFiles`. Import `ChangedFile`, `FileChanges`, `FileChangesQuery`, `PullRequestFilesQuery`, `CommitRangeFilesQuery`, and `PullRequestFilesChangedError` from `@usine/github/file-changes`.
