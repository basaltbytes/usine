---
"@usine/agents": patch
---

A remote Claude child whose SSH connection breaks, for example while the orchestrator's machine sleeps, resumes its saved session instead of failing ([#603](https://github.com/basaltbytes/usine/issues/603)). The backend stops the Claude process left on the worker with the new `CHILD_STOP_SCRIPT`, then starts Claude with `resume` in the same child session, so the parent spends no child budget. It tries after 5 s, 15 s, 30 s, 1 min, 2 min, and 5 min, and fails the child as before after the last try. A child whose Claude process exits on its own, or that runs on the orchestrator's machine, still fails.

`claudeChildLayer` and `claudeChildBackendLayer` require a `ChildProcessSpawner`. `/child-host` exports `SSH_FAILURE`, the exit code of the OpenSSH client when the connection fails.
