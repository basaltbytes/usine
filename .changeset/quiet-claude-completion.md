---
"@usine/agents": patch
---

Keep Claude children open while reported background work and notification turns finish. Add foreground gate and completion instructions to parent and child prompts.

Report explicit unresolved blockers through the non-retryable agent-failure channel using the `[usine:blocked]` final-answer marker.
