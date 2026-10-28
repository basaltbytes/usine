---
"@usine/engine": patch
"@usine/orchestrator": patch
---

Block new attempts across all loops on an item before requesting a parent stop. Keep the block until the stop succeeds, recheck it after a worker slot becomes available, and show stops from other loops in the overview and run detail.
