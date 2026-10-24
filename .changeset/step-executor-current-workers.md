---
"@usine/engine": minor
---

`StepExecutor.workers` is an effect that lists the executor's current workers, including a removed worker until its last attempt ends. `RunEngine.discardLeftovers` reads it on each call and discards the leftovers of a removed worker only after its last attempt ends.
