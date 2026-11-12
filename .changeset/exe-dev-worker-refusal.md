---
"@usine/config": minor
"@usine/orchestrator": patch
"@usine/server": patch
---

An `exe.dev` worker is refused with a message that names it and says that this version of usine doesn't run the kind. The configuration store refuses a commit that leaves an `exe.dev` worker in the configuration, and `usine up` refuses a stored one before it starts. Before, an instance whose workers were all `exe.dev` was told that the worker differed from the other workers. `@usine/config/factory` exports `exeDevWorkerRefusal`, the shared message. Replaying stored revisions, such as for a revert, still accepts `exe.dev` workers.
