---
"@usine/github": minor
"@usine/orchestrator": patch
"@usine/server": patch
---

`GitHubChecks.pendingDetails` takes a `historyDeadline` and returns a `PendingCheckReport` instead of an array of `PendingCheck` records. The report lists running jobs before queued ones and counts in `omitted` the pending checks after the first ten. When no check run is pending, it lists the head's pending legacy commit statuses. Duration history reads stop at the deadline or at the first rate limit and keep the durations already read, so a slow history read no longer discards the job list. The baseline for a job's previous duration now comes from the latest successful run of the same workflow and event.

The CI timeout diagnostic now reads "has been running for 31 min; its last successful run took 6 min" instead of quoting GitHub's `in_progress` status, states when a running job has no recorded start time, and says how many pending checks it leaves out. When the diagnostic read fails, its warning log includes the failed GitHub operation and message.
