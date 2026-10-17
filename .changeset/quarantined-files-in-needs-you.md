---
"@usine/config": patch
"@usine/orchestrator": patch
"@usine/server": patch
---

`usine up` reports the Loop and Agent files it left out. `InstanceFolder.load` logs a warning for each quarantined Loop and invalid Agent file with its file, stage, and message, and the operator overview lists each one in Needs you as a `ConfigFileNeed`, exported from `@usine/orchestrator/operator`.
