---
"@usine/orchestrator": minor
---

`RunView` in `@usine/orchestrator/operator` carries `closedAt`, when the run last closed, null while it is open. The desk's last outcomes use it. `BoardTaskView` carries `usage`, a `TaskUsageView` with what the task's runs used: the ended attempts' wall time, when each attempt at work started, the attempts closed before end times were recorded, the tokens, the tokens and dollars per billing pool summed over the runs, and the priced pools' dollars. The overview reads each run on the board's items through `RunUsageReader`, which keeps ended attempts' reports, and `RunUsageReader.read` accepts a run summary as well as a snapshot. Code that constructs `RunView` or `BoardTaskView` adds the fields.
