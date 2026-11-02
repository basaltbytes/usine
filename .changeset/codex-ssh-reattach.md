---
"@usine/agents": patch
"@usine/durable": patch
"@usine/executor": patch
---

Keep remote Codex app-servers running through SSH drops and reattach to their pending turns. Resume the saved thread once if the app-server exits, preserving operator pauses and idle sessions. Record child transport failures as infrastructure failures even after earlier child reports or parent blockers, so attempts retry automatically from recorded salvage.

Preserve the original task when an app-server exits before saving its first user message. Recovery continues saved work when the task is already recorded.
