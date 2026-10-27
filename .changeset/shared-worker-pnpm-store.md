---
"@usine/executor": patch
---

Share a persistent pnpm store volume across attempt containers on each SSH worker machine. Initialize volume ownership with the image's usine UID before use, refuse a store owned by another UID, and log disk usage at preflight.
