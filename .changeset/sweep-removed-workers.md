---
"@usine/executor": patch
---

Sweep a removed provisioned worker's machines before discarding its provider token. Warn at startup about machines for the instance whose worker is no longer configured, and use fresh credentials when a worker is added again.
