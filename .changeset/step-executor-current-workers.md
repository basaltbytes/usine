---
"@usine/engine": minor
---

`StepExecutor.workers` is an effect that lists the Workers the executor runs Attempts on now, so a Worker a reload removes stays in the list until its last Attempt ends and leaves it then. `RunEngine.discardLeftovers` reads it on each call: it keeps the leftovers of a Worker that is configured or still runs Attempts, and discards those of a removed Worker once its last Attempt has ended.
