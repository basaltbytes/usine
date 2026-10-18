---
"@usine/core": patch
"@usine/agents": patch
"@usine/durable": patch
"@usine/executor": patch
---

A retried Attempt starts from the Run's revision as it is now, the default branch tip for an issue Run, and rebases the previous Attempt's salvage onto it instead of checking the salvage out on its old base. A salvage with no changes beyond the revision is dropped. A salvage that does not rebase cleanly is left out: the Attempt starts from the revision, the salvage branch keeps the work, and the new `RunSpec.conflictingSalvage` and `Started.conflictingSalvage` name it, so the Agent's prompt and the Attempt's transcript mention it.
