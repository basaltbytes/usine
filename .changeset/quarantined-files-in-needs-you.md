---
"@usine/config": patch
"@usine/orchestrator": patch
"@usine/server": patch
---

`usine up` logs a warning with the file, stage, and message for each loop or agent file it left out, and **Needs you** lists each one as a `ConfigFileNeed` (`@usine/orchestrator/operator`).
