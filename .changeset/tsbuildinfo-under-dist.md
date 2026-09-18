---
"@usine/agents": patch
"@usine/config": patch
"@usine/core": patch
"@usine/engine": patch
"@usine/executor": patch
"@usine/expression": patch
"@usine/github": patch
"@usine/orchestrator": patch
"@usine/run-host": patch
"@usine/server": patch
---

Write each package's `tsc -b` build info under `dist/`, so removing `dist` by hand also removes the incremental state and the next build re-emits instead of finding nothing to do. The build info is excluded from the published files.
