---
"@usine/core": minor
"@usine/agents": patch
"@usine/durable": patch
"@usine/executor": patch
"@usine/orchestrator": patch
"@usine/server": patch
---

Record the resolved billing pool on parent and child sessions and preserve parent billing across restarts. API-key sessions record their endpoint's provider name when available. Usage reads the recorded pool, with compatibility for older transcripts.
