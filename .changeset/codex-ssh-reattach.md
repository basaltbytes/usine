---
"@usine/agents": patch
"@usine/durable": patch
"@usine/executor": patch
---

Keep remote Codex app-servers running through SSH drops and reattach to their pending turns. Resume the saved thread once if the app-server exits. Preserve child transport failures as infrastructure failures so attempts retry automatically from recorded salvage.
