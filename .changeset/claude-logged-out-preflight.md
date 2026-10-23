---
"@usine/agents": patch
---

Preflight reports a logged-out Claude Code worker as needing `claude auth login` instead of as a failed command. Other non-zero exits and output that isn't a login status still report the command as failed.
