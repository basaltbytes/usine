---
"@usine/core": minor
"@usine/engine": minor
"@usine/github": minor
"@usine/orchestrator": minor
"@usine/server": minor
---

A CI wait no longer treats a partially created GitHub Actions run as green or as a failure for the fix loop. Before it applies completion labels or starts a fix, usine reads the latest run of each workflow on the recorded head, unless a check on that head already failed. When a run concluded `failure` or `cancelled` with no failed job, such as a run whose jobs Actions never created, the wait ends in **Needs attention** as an infrastructure failure that names each run ID and link. usine applies no completion labels and starts no fix. A failed job or failed commit status on the head still starts the fix loop. A failed job starts the fix loop without waiting for other workflow runs. Otherwise, a workflow run that hasn't concluded keeps the wait pending, even after its last job finished and the checks read green, until the CI deadline. usine doesn't rerun workflows, so the App doesn't need **Actions: read and write**; rerun the named runs and apply the completion labels after the checks pass.

`GitHubChecks.workflowRuns` from `@usine/github/checks` returns these runs as `IncompleteWorkflowRun` records and runs that haven't concluded as `RunningWorkflowRun` records, and `CiIncomplete` from `@usine/core/ci` is the CI resolution that settles the wait.
