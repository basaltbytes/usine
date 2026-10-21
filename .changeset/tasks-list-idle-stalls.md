---
"@usine/server": patch
---

The web UI's Tasks list counts a stalled Task as in flight only while an open Run, an Agent's question or blocker, a used-up cycle budget, or a failure not yet resolved holds its Loop. A Task whose last Run closed on an Item unchanged since, whose Item waits for the next poll, whose Loop is paused, or whose failure is resolved sorts with the finished Tasks by when its last Run closed and keeps the stall reason, such as `Canceled 3d ago, unchanged since`, as its status. The heading counts such a Task as needing attention while a failed Run or a hold waits on the operator, and leaves it out otherwise.
