---
"@usine/github": patch
"@usine/orchestrator": patch
"@usine/server": patch
---

Route a pull request with merge conflicts and no checks to the configured CI fix loop. The fix task includes conflict resolution instructions and inherits pending completion actions. Unknown mergeability keeps the CI wait pending.
