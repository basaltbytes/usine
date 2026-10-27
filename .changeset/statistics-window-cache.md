---
"@usine/orchestrator": patch
---

Cache task and run statistics per window for up to five minutes. Repeated requests reuse computed views while the instance and store revision remain unchanged. Run closure, retry, close-time changes, and item or budget updates invalidate the cache. Concurrent requests share computation, and debug logs report hits and misses.
