---
"@usine/agents": patch
---

A Claude child that answers while its background tasks still run waits at most two minutes for that work and the turn it starts. When the limit passes and the child is still idle, the child returns its answer, a warning names the limit and the background task IDs, and closing the child ends the Claude Code process. Before, a review that had already posted its verdict could hold its worker slot until a leftover CI watch ended. A new turn within the limit still runs to its own answer. If the operator holds or pauses the child when the limit passes, the child stays open without reporting idle. A Release of a held child then returns the answer, unless a turn started first. If the Claude process resumes in the meantime, the child reports the kept answer as idle, and a Release returns it. The limit is kept in memory, so a child that usine reattaches after a restart waits for its background work without a limit.
