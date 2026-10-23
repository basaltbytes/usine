---
"@usine/agents": patch
"@usine/config": patch
"@usine/core": patch
"@usine/engine": patch
"@usine/executor": patch
"@usine/expression": patch
"@usine/github": patch
"@usine/orchestrator": patch
"@usine/server": patch
---

Each package writes its `tsc -b` build info under `dist/`, so removing `dist` also removes the incremental state. The build info isn't published.
