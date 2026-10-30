---
"@usine/orchestrator": minor
"@usine/server": minor
---

Run preflight on an idle worker from Configuration > Workers or `POST /api/workers/:worker/preflight`. Checks refresh the worker's stored results, scheduling availability, and Needs attention without a restart. Busy workers return a typed refusal.
