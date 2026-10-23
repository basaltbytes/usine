---
"@usine/durable": minor
---

A durable conversation document that no longer reads back fails only its attempt, with an `InfraFailure` that states the reason, instead of stopping the harness. `DurableHarness.resume` takes a `BeforeResume` step that runs on every opened harness before its tasks resume, including after a reopen.
