---
"@usine/orchestrator": minor
---

Adds `closedAt` to `RunView` in `@usine/orchestrator/operator`, which the desk's last outcomes use, and `usage` to `BoardTaskView`: a `TaskUsageView` with the task's wall time, tokens, and dollars per billing pool (`TaskPoolUsageView`). A pool's `unpriced` flag marks its `cost` as a lower bound, and `RunUsageReader.read` accepts a run summary as well as a snapshot.

Add the new fields to code that constructs `RunView` or `BoardTaskView`.
