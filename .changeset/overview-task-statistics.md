---
"@usine/orchestrator": patch
"@usine/server": patch
---

`GET /api/statistics` now returns the tasks done in the window, a task being done when its pull request merges: each task's time from its first run to the merge with the median, the split of task time between the loops' attempts and waiting, each loop's median run time, the share of tasks with no second round, the operator actions per task, and the tokens per task by loop, with a cost only when every session has a price. The run statistics move to `GET /api/statistics/runs`, which reports medians only.

The Statistics section now leads the overview with four blocks: Tasks done, Time per task, First time right, and Tokens per task. The run statistics sit behind a collapsed Details disclosure and load when it opens.
