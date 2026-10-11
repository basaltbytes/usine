---
"@usine/agents": minor
"@usine/run-host": patch
---

`ChildRequest.host` says where a child runs. `@usine/agents/child-host` defines `LocalProcess` (this machine, with `ChildRequest.environment` as the child's complete environment) and `RemoteShell` (one SSH command per child that changes into the worktree, exports the environment on top of the remote machine's own, records the child's pid beside the worktree while it runs, and executes the harness), plus the shell quoting the executors share. Claude Code children reach a remote host through the Agent SDK's `spawnClaudeCodeProcess`, Codex children run their app server over SSH, and Pi children refuse a remote host with `AgentResultError`.

`preflight(brain, host)` and `verifyHarness(brain, host)` take the host the checks run on. On a `RemoteShell` host each probe runs over SSH, an SSH failure is an incomplete check rather than a missing harness, and a Pi brain is unavailable. The Claude live contract joins the Codex and Pi ones (`test:integration:claude`), and the Claude and Codex contracts also run through a local SSH stand-in.
