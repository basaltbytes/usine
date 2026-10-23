---
"@usine/server": patch
---

The tasks list counts a stalled task as in flight only while an open run, a question or blocker, a used-up cycle budget, or an unresolved failure holds one of its loops. Other stalled tasks sort with finished tasks by when their last run closed and keep the stall reason as their status, and the heading counts a task as needing attention only while a failed run or hold waits on the operator.
