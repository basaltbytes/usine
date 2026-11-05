---
"@usine/core": minor
"@usine/engine": minor
"@usine/github": minor
"@usine/orchestrator": minor
"@usine/server": minor
---

Show whole pull request and recorded attempt changes on task pages with collapsed file diffs, change counts, and CI and review state. Add a project-scoped files API and commit-based caching, with explicit reporting for missing and truncated GitHub patches.

Keep recorded attempt changes available after failed or canceled CI waits, including when a later retry succeeds.

Backfill older comparisons only when their producing attempt is identifiable, and let each attempt's completion replace an existing backfilled result.

Classify generated files by path to avoid marking hand-written files whose patches mention generated-file markers.
