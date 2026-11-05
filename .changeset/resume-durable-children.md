---
"@usine/durable": patch
---

Resume saved child conversations after an orchestrator restart in the original checkout and attempt transcript. Recovery preserves operator holds, child IDs, and budget slots and returns committed output as an interrupted result when resume is unavailable or fails.

A resumed child's final report replaces its pre-restart infrastructure failure while preserving blockers from other children.

Failed recovery allows a replacement child to supersede the previous infrastructure failure. Resumed children use the worker's current credential kind; incompatible saved conversations return an interrupted result with the committed output.
