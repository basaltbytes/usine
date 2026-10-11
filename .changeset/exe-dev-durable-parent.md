---
"@usine/executor": minor
"@usine/orchestrator": minor
---

Run the exe.dev Worker's Pi parent in the orchestrator as a durable task and its Claude Code and Codex children on the VM over SSH, so an exe.dev Attempt reattaches after an orchestrator restart instead of failing.

`@usine/executor/exe-dev` requires an `AttemptRuntime` and no longer launches the run host: `ExeDevExecutorOptions.runHost` is gone, preflight runs the `@usine/agents/preflight` checks on the VM over SSH instead of the run host's protocol and Node.js checks, and a Pi brain is unavailable on exe.dev. Launch passes a `RemoteShell` child host and `GH_HOST=github.int.exe.xyz` to the parent task and harvests commits and pull requests over SSH. Each remote child's pid file beside the worktree lets cleanup, cancel, recovery, and reattach stop every child before the worktree is kept or removed. `isLive` reads the parent task, and `prepare` with `reattach` takes over the VM worktree with a fresh credential grant, or fails and cancels the task when the worktree is gone.

`RunHostCommand` is removed: `ExeDevExecutorOptions.ssh` takes an `SshCommand` from `@usine/agents/child-host`. The `run-host` Worker capability is removed. The local executor's harness probe and durable session are shared with exe.dev and unchanged in behaviour, except that a failed read of a reattached Attempt's stored request now reports "Could not read the reattached Attempt's durable request". `@usine/orchestrator/exe-dev`'s `layer` requires an `AttemptRuntime`, as the local one does.
