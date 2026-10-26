---
"@usine/server": patch
---

`usine up --detach`, `usine restart`, and `usine upgrade` wait for a long startup recovery instead of reporting that the new process didn't answer. The orchestrator listens only after startup recovery reconciles the checkouts that earlier attempts left on workers, which can take minutes. A start now keeps waiting while the new process writes to `.usine/usine.log`, and gives up after `--timeout` seconds (120 by default) in which the process neither listens nor writes a line. The process keeps running when the command gives up.
