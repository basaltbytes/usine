---
"@usine/agents": patch
---

Fix Codex checkout trust overrides so children disable project-local configuration, hooks, and exec policies even when the saved configuration marks the checkout as trusted. Start the app server outside the home directory to avoid repeated configuration warnings.
