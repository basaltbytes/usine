---
"@usine/core": patch
"@usine/agents": patch
"@usine/durable": patch
---

Keep held children that finished their turn idle after an orchestrator restart. Release returns the saved report to the parent; operator guidance starts another turn. Include the completed report in SessionIdle events for recovery.
