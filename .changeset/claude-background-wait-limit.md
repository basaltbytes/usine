---
"@usine/agents": patch
---

A Claude child that answers while its background tasks still run waits at most two minutes for that work and the turn it starts. When the limit passes and the child is still idle, the child returns its answer, a warning names the limit and the background task IDs, and closing the child stops the background work. Before, a review that had already posted its verdict could hold its worker slot until a leftover CI watch ended. A new turn within the limit still runs to its own answer.
