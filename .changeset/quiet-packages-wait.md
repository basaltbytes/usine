---
"@usine/server": patch
"@usine/core": patch
"@usine/orchestrator": patch
---

Wait for all usine dependencies to resolve on npm before offering or starting a server upgrade. Retry registry propagation errors during installation, and record the rollback failure stage so automatic mode can retry install failures while continuing to skip health-check failures.
