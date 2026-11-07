---
"@usine/engine": patch
"@usine/orchestrator": patch
"@usine/server": patch
---

Replay blocked CI fix events after a cycle-budget reset without requiring a trigger label. Recheck the recorded PR head before admission and preserve failure diagnostics and completion actions across restarts. Keep paused fixes queued until their loop resumes.
