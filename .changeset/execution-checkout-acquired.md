---
"@usine/engine": minor
"@usine/orchestrator": patch
---

`StepExecutor.execute` takes an `ExecutionSink`: the Attempt's channel sink and `checkoutAcquired`, which the executor runs once preparation holds the Attempt's checkout, and never when preparation fails. The engine keeps reconciling a checkout a restart kept for a reattachment until then, and logs `The reattached Attempt's execution acquired the checkout startup kept; its executor releases it from here` at info when it hands the checkout over. Canceling the Run before the hand-off, including while the scheduler still reads the settings and the bot login before it prepares the reattachment, records the Attempt's salvage and removes the checkout. A reattachment that fails before the hand-off, such as one whose credential cannot be issued, has its checkout reconciled before the Attempt's failure is recorded, and the next Attempt resumes from that salvage. The orchestrator's scheduler runs `checkoutAcquired` between `Executor.prepare` and the launch.
