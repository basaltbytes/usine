---
"@usine/core": patch
"@usine/executor": patch
"@usine/engine": patch
"@usine/orchestrator": patch
"@usine/server": patch
---

Record kernel task names and host PIDs for processes killed by attempt container memory limits. Show available process details and missing-detail counts below attempt outcomes, and report memory kills and repeated kills beside first-time-right statistics. Older records retain their kill counts with empty process lists.

Serialize the repository check and build tasks to fit the worker memory limit, matching the existing test command. Document gate memory requirements and host kernel-log permissions.
