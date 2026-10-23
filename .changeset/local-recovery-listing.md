---
"@usine/executor": patch
---

Startup reconciliation lists local worker checkouts once instead of checking each attempt, caches a listing failure until restart without blocking other workers, and still records salvage before it removes a checkout.
