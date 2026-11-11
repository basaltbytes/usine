---
"@usine/agents": patch
---

A turn result logs a Claude control request that is still unanswered only once, at the first turn result handled after the request, instead of at every turn result. The cancellation log no longer has a `released` field: it is at Info when the cancellation releases a pending request and at Debug otherwise. Blank Claude stdout lines, such as the empty line after each `\r\n`, are checkpointed without a Debug log. A late response to a cancelled control request no longer answers a later request that reuses its ID, whether the output checkpoint reads the later request before or after that response; the later request stays pending until its own response follows the late one. Saved Claude usage drops superseded message IDs as soon as an acknowledged hook response lets the output checkpoint catch up, instead of at the next message the checkpoint covers.
