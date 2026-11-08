---
"@usine/agents": patch
---

Accept Codex responses that omit keys the app-server protocol marks optional, such as the model list cursor and a turn's error. Codex schema generation fails on schema shapes it can't translate faithfully instead of producing a wrong decoder.
