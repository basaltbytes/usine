---
"@usine/core": minor
"@usine/engine": minor
"@usine/orchestrator": minor
"@usine/server": minor
---

Allow operators to mark a failed Run's latest failure resolved. Resolution persists for that Attempt and clears its Needs you, Project, and Board attention while preserving the failed outcome, transcript, and retry controls. Later failures request attention again; stale resolution requests are rejected.
