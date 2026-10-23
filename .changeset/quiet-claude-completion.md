---
"@usine/agents": patch
---

Claude children stay open until background work and notification turns finish. An agent reports an unresolved blocker with the `[usine:blocked]` marker, which fails the attempt without a retry.
