---
"@usine/agents": patch
---

Preflight reads the status `claude auth status --json` prints when it exits 1, which Claude Code does when nobody is logged in, so a logged-out Worker is told to run `claude auth login` instead of being told the command failed. Any other non-zero exit, or output that is not a login status, still reports the command as failed.
