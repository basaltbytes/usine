---
"@usine/agents": patch
---

By default, Claude Code children add no attribution to commits or pull request descriptions. Each child starts with `attribution` set to an empty `commit` and `pr` text in Claude Code's flag settings, which take precedence over the worker user's `settings.json`. Instructions about attribution in the repository's `CLAUDE.md` or in Claude Code memory still take precedence over these settings.
