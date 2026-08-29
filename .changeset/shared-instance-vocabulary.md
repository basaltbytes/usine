---
"@usine/core": minor
"@usine/engine": patch
---

Move the instance-folder directory brand and the approval-requirement literal set into `@usine/core` (`Instance.Directory`, `Loop.ApprovalRequirement`) so the engine and the config loader share one owner. `@usine/engine` re-exports `InstanceDirectory` and `ApprovalRequirement` unchanged.
