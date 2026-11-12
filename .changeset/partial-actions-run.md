---
"@usine/core": minor
"@usine/engine": minor
"@usine/github": minor
"@usine/orchestrator": minor
"@usine/server": minor
---

A CI wait no longer treats a partially created GitHub Actions run as green or as a failure for the fix loop. Before it applies completion labels or starts a fix, usine reads the latest run of each workflow on the recorded head. When a run concluded `failure` or `cancelled` with no failed job, such as a run whose jobs Actions never created, the wait ends in **Needs attention** as an infrastructure failure that names each run ID and link. usine applies no completion labels and starts no fix. A failed job or failed commit status on the head still starts the fix loop without waiting for other workflow runs, except a gate job that failed only because jobs it needs stayed queued. Before the CI deadline, CI that ran only in part keeps the wait pending while a check outside the concluded runs, such as a commit status, is still pending. A job that fails while usine reads CI waits for the next poll. Otherwise, a workflow run that hasn't concluded keeps the wait pending, even after its last job finished and the checks read green, until the CI deadline. usine doesn't rerun workflows, so the App doesn't need **Actions: read and write**; rerun the named runs and apply the completion labels after the checks pass.

`GitHubChecks.workflowRuns` from `@usine/github/checks` returns runs that concluded `failure` or `cancelled` as `FailedWorkflowRun` records and runs that haven't concluded as `RunningWorkflowRun` records. `GitHubChecks.unfinishedChecks` returns the check runs and commit statuses on a head that haven't completed as `UnfinishedCheck` records, and `CiIncomplete` from `@usine/core/ci` is the CI resolution that settles the wait.
