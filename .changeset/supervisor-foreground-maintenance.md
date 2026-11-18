---
"@usine/executor": patch
---

Wait for automatic Git maintenance during supervisor source preparation. Maintenance continues to consolidate cached packs and finishes before preparation returns, preventing detached Git processes from racing cache cleanup.
