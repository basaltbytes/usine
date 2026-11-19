---
"@usine/agents": patch
---

The Codex app-server starts with `sandbox_mode = "danger-full-access"` as its default. Every thread usine starts still sets its own sandbox, and Codex no longer reports `Codex's Linux sandbox uses bubblewrap and needs access to create user namespaces.` at each start in a container without user namespaces.
