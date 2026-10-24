---
"@usine/agents": minor
---

`ChildRequest.host` sets where a child runs: `LocalProcess`, or `RemoteShell`, which runs each child through one SSH command in the worktree. `@usine/agents/child-host` also exports `sshArguments` and `CHILD_KILL_SCRIPT`; Claude Code and Codex children support a remote host, and Pi children refuse it with `AgentResultError`.

`preflight(brain, host, environment)` and `verifyHarness(brain, host, environment)` take the host and environment to check. On a `RemoteShell` host, probes run over SSH, an SSH failure is an incomplete check, and a Pi brain is unavailable.
