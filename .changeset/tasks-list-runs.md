---
"@usine/server": patch
---

The tasks list shows only tasks with at least one run, finished ones included, and removes the Done toggle and `?done=1`. Each row shows the status, the loops that ran, the run count, the last run, the pull request, and the task's time, tokens, and cost; tasks in flight come first by when their run opened, then the rest by when their last run closed.
