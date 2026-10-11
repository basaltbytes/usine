---
"@usine/agents": minor
---

`ChildRequest.host` says where a child runs. `@usine/agents/child-host` defines `LocalProcess` (this machine, with `ChildRequest.environment` as the child's complete environment) and `RemoteShell` (one SSH command per child that changes into the worktree, exports the environment on top of the remote machine's own, records the child's pid beside the worktree while it runs, and executes the harness), plus `sshArguments` for other commands on the same machine and `CHILD_KILL_SCRIPT`, which stops every child a worktree's pid files record. Claude Code children reach a remote host through the Agent SDK's `spawnClaudeCodeProcess`, Codex children run their app server over SSH, and Pi children refuse a remote host with `AgentResultError`.

`preflight(brain, host, environment)` and `verifyHarness(brain, host, environment)` take the host the checks run on and the environment their processes see, as a child's would. On a `RemoteShell` host each probe runs over SSH, an SSH failure is an incomplete check rather than a missing harness, and a Pi brain is unavailable. The Claude live contract joins the Codex and Pi ones (`test:integration:claude`), and the Claude and Codex contracts also run through a local SSH stand-in.
