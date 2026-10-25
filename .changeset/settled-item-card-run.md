---
"@usine/orchestrator": patch
---

A board card no longer shows the failure note, run line, or **Retry** of a failed run on an issue that is closed or a pull request that is closed or merged. `BoardTaskView.run` now prefers a run that needs the operator by the same check as `needsYou`, so such a run gives way to the task's open run. The run keeps **Retry** on the task page and the run page.
