---
"@usine/agents": patch
---

Codex and Pi children record their prompt receipt, as Claude Code children do, so a delegation's saved progress no longer reports that a Codex or Pi child never received its task. Codex records it when its first turn starts, and Pi when it saves the first user message of its conversation. Only Claude Code reads the receipt after a restart.
