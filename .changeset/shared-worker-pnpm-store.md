---
"@usine/executor": patch
---

Share a persistent pnpm store volume across attempt containers on each SSH worker machine. Require image UID 1000, initialize volume ownership before use, and log disk usage at preflight.
