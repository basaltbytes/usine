---
"@usine/durable": patch
---

Resume saved child conversations after an orchestrator restart in the original checkout and attempt transcript. Recovery preserves child IDs and budget slots and returns committed output as an interrupted result when resume is unavailable or fails.
