---
"@usine/durable": patch
"@usine/executor": patch
---

Settle attempts after confirmed cancellation so a task that completes or fails while its relay fails doesn't trigger repeated cancellation on restart. Preserve terminal delivery state and skip settlement during worker drains.
