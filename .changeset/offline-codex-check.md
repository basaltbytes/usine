---
"@usine/agents": patch
---

Generate and check the Codex protocol schemas from a committed copy of the pinned upstream schema, so `codex:generate` and `codex:check` work without network access. `codex:check:upstream` also confirms that the copy matches the pinned commit, and reports a failed fetch in one line with exit code 2. A remote child without a session, or a remote readiness check, given a non-empty environment now fails instead of exporting the values on the SSH command line.
