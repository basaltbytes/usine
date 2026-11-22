---
"@usine/core": minor
"@usine/agents": patch
---

`HarnessSession.make` requires the harness's conversation `id`; the schema no longer assigns a UUID. The Claude Code adapter draws one for a new conversation, because Claude Code takes the ID from its caller.
