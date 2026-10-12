---
"@usine/durable": minor
---

A durable conversation document that no longer reads back fails only the Attempt that owns the conversation instead of stopping the harness. Each time the harness opens, before its tasks resume, the Attempt runtime reads the `pi.*` documents of every live task's conversation, replaces the unreadable ones with their initial value in one commit, records the reason on the owning Attempt's record, and aborts that Attempt's task, which then fails with an `InfraFailure` that states the reason. Other Attempts in the same storage keep running. The stuck-step detection stays for steps that do not come from an unreadable document.

`DurableHarness.resume` takes the `BeforeResume` step to run on every opened harness before its tasks resume, including after a reopen.
