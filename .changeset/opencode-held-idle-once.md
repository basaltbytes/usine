---
"@usine/agents": patch
"@usine/server": patch
---

A held OpenCode child reports each answer idle once. Before, when the last steer that an answer waited for failed and a read of OpenCode's state then waited for a retry, an operator message could start and finish the next execution in the meantime, and the child reported that execution's answer idle twice.
