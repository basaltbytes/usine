---
"@usine/orchestrator": patch
---

A reload can add an SSH worker and reads its gateway's admin token before preflight; an unset token variable refuses the reload. A removed SSH worker leaves after its last attempt.
