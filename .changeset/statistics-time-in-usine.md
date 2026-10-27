---
"@usine/orchestrator": patch
"@usine/web": patch
---

A task's time in the overview statistics now ends at its last run's close instead of its merge, so the wait for the operator to merge a ready pull request is left out. A run still open at the merge counts until the merge. The time split per loop uses the same span.

The median price of a task now covers the tasks whose sessions all have a price, instead of disappearing when one session lacks a price. `TaskCostView` has the count of priced tasks in `tasks`. The overview shows the median price beside the median time in usine, and the line under the blocks counts the tasks left out of it.
