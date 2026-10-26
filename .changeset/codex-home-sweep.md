---
"@usine/executor": minor
"@usine/orchestrator": patch
---

An SSH worker no longer keeps the Codex home of an attempt that a crash ended. `Executor` has a new required member, `sweep`, which removes the files on the workers that no attempt holds or can use, and never fails. `StepExecutor.sweep` in the orchestrator's scheduler runs it before the sweep of provisioned machines, after startup recovery and at each reconcile.

The SSH executor's sweep lists `<root>/workers/<name>/codex/` on each worker with its own machine and removes each Codex home whose attempt has no checkout there and that no attempt in this process holds. An attempt holds its Codex home from before the executor writes it until cleanup removes it, so a running attempt keeps its home, and so does a checkout that startup keeps for a reattachment. The local, exe.dev, and Cloudflare executors remove nothing.
