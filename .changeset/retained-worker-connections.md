---
"@usine/executor": minor
"@usine/orchestrator": minor
---

Apply SSH and Cloudflare connection changes without restarting. New attempts use the updated connection; open and retained attempts keep their original machine, container settings, gateway, and client through recovery and restart. Cancel provisioning retries when an SSH worker switches to a fixed destination. Persist per-attempt connection metadata using credential references in the Node orchestrator.
