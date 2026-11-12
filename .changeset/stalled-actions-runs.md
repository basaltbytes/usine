---
"@usine/core": minor
"@usine/engine": minor
"@usine/github": minor
"@usine/orchestrator": minor
"@usine/server": minor
---

A CI wait now tells a stalled or incomplete GitHub Actions run apart from red CI, and explains how to recover. At the CI deadline, usine reads the workflow runs on the recorded head even while the checks are pending. If GitHub Actions left a run `queued` or `in_progress`, the timeout message says that Actions didn't finish it and names the run with its ID and link. It tells you to push a commit or to rerun the run once GitHub allows it. A gate job that failed only because jobs it needs stayed queued is incomplete CI, not a failure: the wait ends in **Needs attention** as an infrastructure failure that names the run and the jobs that didn't finish, and it starts no fix. While that run is still going, the wait stays pending, because the queued jobs can still start.

A run whose CI wait ended this way offers **Apply CI labels** in **Needs attention**. After CI on the same head passes, with every workflow run concluded in full, the action applies the wait's completion labels and marks the failure resolved. While CI on the head hasn't passed, it applies nothing and shows why. The operator API exposes it as `POST /api/runs/{runId}/apply-ci-labels`, which answers `409` with `CiNotPassedError` until CI passes.

`RunState.Failed` from `@usine/core/run/state` keeps the wait's handoff as `unfinishedCi`, and `operatorActions` reports `canApplyCiLabels`. `GitHubChecks.workflowRuns` from `@usine/github/checks` reports a run's lone failed job and the jobs that didn't finish as `LoneJobFailure`. `CiMonitor.applyLabelsAfterGreen` applies the labels, and `RunView.canApplyCiLabels` and `RunFailureNeed.unfinishedCiAttemptId` from `@usine/orchestrator/operator` expose the action.
