---
"@usine/agents": patch
"@usine/server": patch
---

A remote OpenCode child no longer fails when its bridge is lost during a read of OpenCode's state that runs after a failed steer made the answer due. The read logs the loss and stops, and the child reopens its session on a new bridge, as it does when the loss happens during any other read. A check that started before a restart doesn't answer for the reopened session.
