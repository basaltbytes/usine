---
"@usine/engine": patch
"@usine/orchestrator": patch
"@usine/server": patch
---

Keep worker slots free while an idle upgrade defers new attempts. Show the requested version on deferred runs and worker rows, and report prolonged waits in Needs attention. Cancel a pending upgrade from Settings or with `DELETE /api/upgrade` to resume attempts without restarting.
