---
"@usine/core": patch
"@usine/engine": patch
"@usine/orchestrator": patch
"@usine/server": patch
---

Show a dismissed cycle-budget entry again when a later event is blocked on the same item, and display the most recently blocked loop. Preserve dismissals during repeated polling of the same blocked events and keep the ask's reset identity unchanged.

Add `CycleBudgetBlock`, `CycleBudgetAsk.blocks`, `recordBlock`, and `blockedLoop` to record the latest refused event per loop. Older asks decode with an empty block list.
